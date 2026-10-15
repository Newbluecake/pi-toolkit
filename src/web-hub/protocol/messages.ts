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
  /** tool-duration plan: `subagent:web-tool-timing` custom(data) entries carry their bounded
   *  `{[toolCallId]: durationMs}` map here (the entry otherwise stays a display:false tombstone —
   *  never a transcript row). Absent on every other entry shape; ≤ TOOL_TIMING_WIRE_PAIRS pairs. */
  timing?: Record<string, number>;
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

/** `StatusInfo.todo`'s body: a bounded, open-first projection of the main session's task list
 *  (todo-archive D5: `[...open, ...3 most-recent completed]`, archived tasks never emitted). */
export interface TodoWire {
  /** ≤ TODO_WIRE_MAX_TASKS (32), `[...open, ...recentCompleted]` — open tasks first. */
  tasks: TodoTaskWire[];
  /** Non-archived task count (includes capped/folded-away rows; archived never counted);
   *  always = counts open+inProgress+completed. */
  total: number;
  /** Counts over the non-archived population; `blocked` = non-completed tasks with open blockers
   *  (lookups always against the FULL task list — todo-archive D7). */
  counts: { open: number; inProgress: number; completed: number; blocked: number };
  /** total - tasks.length, when the 32-task cap, the recent-3 fold or the byte budget dropped
   *  rows (todo-archive D5: includes the folded completed tasks). */
  omitted?: number;
  /** todo-archive D5: completed (non-archived) tasks not emitted as rows (recent-3 fold + cap /
   *  budget drops). Sent ONLY while the live hub's hello_ack.caps carries `todo.archive.v1`. */
  completedHidden?: number;
  /** todo-archive D5: archived task count (never in rows/total/counts). Sent ONLY while the live
   *  hub's hello_ack.caps carries `todo.archive.v1`. */
  archived?: number;
  /** max(updatedAt) over the projected tasks ("recently updated" display; pre-budget-trim). */
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

/** P7w (quota-plan §9A.1): `month` only comes from an agent that saw hello_ack.caps ∋ `quota.pools.v1`. */
export type QuotaScopeWire = "5h" | "week" | "month";
/** P7w: `droid-*` ids only come from an agent that saw `quota.pools.v1`. */
export type QuotaProviderIdWire = "zai-coding-cn" | "zai" | "kimi-coding" | "droid-standard" | "droid-core";

/**
 * quota-web plan §1 (D1-D9): one window (`5h`/`week`, displayed as `7d`) of a provider's
 * `StatusInfo.quota` row. `etaMs`/`resetAt` absent ⇒ no prediction / unknown reset — the UI
 * must not synthesize either. The web pill/card renders countdowns from these absolute
 * timestamps locally (D2: the agent side never re-pushes purely for a clock tick).
 */
export interface QuotaWindowWire {
  scope: QuotaScopeWire; // month only from an agent that saw `quota.pools.v1` (P7w)
  usedPct: number; // 0..100
  level: 0 | 1 | 2 | 3;
  resetAt?: number; // epoch ms
  etaMs?: number; // 预测耗尽还剩多久；不燃烧/样本不足时缺省
}

/**
 * quota-web plan §1: one provider row. Deliberately **open** (no `additionalProperties:false`,
 * see `QuotaWireSchema` below) — same forward-compat posture as `WorktreeRowWire`/`BashJobRowWire`:
 * a `decodeWith` failure drops the whole status frame, which a stale hub during the replacement
 * window could otherwise do forever.
 */
export interface QuotaProviderWire {
  id: QuotaProviderIdWire;
  plan?: string; // GLM 的档位（max/pro…）
  level: 0 | 1 | 2 | 3; // provider 级 = 窗口 max
  stale: boolean;
  /** verification r_WV2Y9VQZ #2 (append-only, optional): the snapshot's own `fetchedAt`, so the
   *  stale badge can show an age ("stale N min") instead of a bare marker. Absent on an older
   *  agent peer, or defensively if the underlying verdict ever lacks one — the UI falls back to
   *  a plain stale badge with no age in that case (never fabricates one). */
  fetchedAt?: number;
  demotedUntil?: number;
  windows: QuotaWindowWire[];
  /** P7w (append-only): droid-* rows only. */
  billing?: QuotaBillingWire;
}

/** P7w: droid-* row billing marker (quota-plan §9A.1). */
export interface QuotaBillingWire {
  overage: "droidCore" | "extraUsage" | "off";
  extraUsageBalanceCents: number; // integer ≥ 0
  gateOpen?: true; // present only when the service decorated the row as gate-open
}

/** P7w: a quota source that cannot be sampled (droid billing API HTTP 401/402/403). */
export interface QuotaProblemWire {
  family: "droid";
  status: number;
}

/**
 * quota-web plan §1/D4: `StatusInfo.quota`'s body. Absent ⇒ no credentials / quota feature off /
 * not sampled yet (byte-equal to the pre-feature shape). `at` is the agent-clock instant the
 * verdicts were read (D5: the UI hoists whichever subscribed session carries the largest `at`
 * to the global TopBar pill).
 */
export interface QuotaWire {
  v: 1;
  at: number;
  providers: QuotaProviderWire[];
  /** P7w (append-only): only in pools mode and non-empty. */
  problems?: QuotaProblemWire[];
}

/**
 * sysload plan (docs/dev/sysload/plan.md) §7.1: the hub's own host-wide CPU/MEM/DISK snapshot,
 * pushed as the direct-send `load` SSE event (never per-agentKey, never through the replay ring
 * — §7.2/§7.4). Self-contained, same posture as `QuotaWire`/`BashJobsWire` above: no cross-
 * feature import — `src/sysload/types.ts` (the pi-free domain module) freezes the SAME
 * level/threshold shape independently, never imported here. `scope` is always `"host"` (the hub
 * samples HOME's filesystem + `/`, never a session cwd — §3); the literal rides the wire so a
 * hypothetical future per-session variant could be added without a shape change. `thresholds`
 * lets the card disclose "阈值取自 hub 启动配置" (§3) instead of assuming the browser's own
 * session agrees. `at`/`intervalMs` are the hub-clock instant/period this snapshot was taken at
 * (sysload plan §10 包注 P0·M9: stale-ness is computed by the BROWSER from the instant it
 * RECEIVES the frame, never from `at` directly — §7.4).
 */
export type LoadLevelWire = "ok" | "warn" | "crit" | "unknown";

export interface LoadThresholdsWire {
  cpu: { warnPercent: number; critPercent: number; psiWarnPercent: number; psiCritPercent: number };
  mem: { warnAvailPercent: number; critAvailPercent: number };
  disk: { warnFreePercent: number; critFreePercent: number; critFreeGiB: number };
}

export interface LoadCpuWire {
  busyPct: number;
  /** PSI cpu `some avg10`; absent when `/proc/pressure/cpu` is missing on the hub host. */
  psiPct?: number;
  level: LoadLevelWire;
  cores: number;
}

export interface LoadMemWire {
  usedPct: number;
  availPct: number;
  level: LoadLevelWire;
}

/** PSI io `some avg10` — display-only (§5.1: IO pressure never gates anything in v1). */
export interface LoadIoWire {
  psiPct?: number;
}

/**
 * One of the ≤2 fixed display paths (§5.4: `~` = HOME's filesystem, `/` = root — no
 * `extraPaths` in v1, §1/§6.1). `skipped` carries WHY the path isn't participating in the level
 * (§5.4): `"remote"` — fstype outside the whitelist (nfs*, cifs, fuse.*, …); `"unresolved"` — a
 * symlinked HOME/cwd whose realpath wasn't proven within its deadline/cache/ledger budget
 * (never lexically guessed). Absent `skipped` with `level:"unknown"` means stale/no-sample yet.
 */
export interface LoadDiskWire {
  label: "~" | "/";
  path: string;
  usedPct: number;
  freeBytes: number;
  totalBytes: number;
  level: LoadLevelWire;
  skipped?: "remote" | "unresolved";
}

export interface LoadWire {
  v: 1;
  at: number;
  /** Projection-time elapsed; the browser anchors at receive time. P1 projects, P4 renders. */
  sinceAgoMs?: number;
  intervalMs: number;
  scope: "host";
  level: LoadLevelWire;
  thresholds: LoadThresholdsWire;
  cpu?: LoadCpuWire;
  mem?: LoadMemWire;
  io?: LoadIoWire;
  /** ≤2, per §5.4/§7.1. */
  disks?: LoadDiskWire[];
  loadavg?: [number, number, number];
}

/**
 * sysload plan §7.1/§5.5: `GET /api/load/top`'s body — the SAME `comm`-aggregated row shape
 * feeds both `byCpu` and `byRss` (sorted differently), matching §5.5's single-shape output.
 */
export interface LoadTopPidWire {
  pid: number;
  /** Absent ⇔ n/a because USER_HZ/page size could not be read. */
  cpuPct?: number;
  /** Absent ⇔ n/a because USER_HZ/page size could not be read. */
  rssBytes?: number;
}

export interface LoadTopRowWire {
  comm: string;
  count: number;
  /** Absent ⇔ n/a because USER_HZ/page size could not be read. */
  cpuPct?: number;
  /** Absent ⇔ n/a because USER_HZ/page size could not be read. */
  rssBytes?: number;
  /** Set when `cpuPct` is a lifetime average (no matching previous-tick sample, §5.5). */
  avg?: true;
  /** ≤8, per §5.5. */
  pids: LoadTopPidWire[];
}

export interface LoadTopWire {
  at: number;
  /** Set when the §5.5 time/pid-count deadline cut the enumeration short. */
  partial?: true;
  /** Fixed top-5 (§5.5), sorted by `cpuPct` desc. */
  byCpu: LoadTopRowWire[];
  /** Fixed top-5 (§5.5), sorted by `rssBytes` desc. */
  byRss: LoadTopRowWire[];
}

/**
 * sysload plan §10 包注 P0·M9: session load-gate truth, riding the same `StatusInfo` slot
 * lifecycle as `todo`/`worktrees`/`bashJobs`/`quota` above — this is the SESSION's own gating
 * verdict (§5.3's effective gate for THIS pi process), distinct from the hub-wide `LoadWire`
 * (which carries no gating concept at all, §7.2). `sinceAgoMs` is elapsed time since the
 * CURRENT level was reached, computed at the agent's own `at` instant — never a raw mono
 * `since` (M9's whole point: the browser re-anchors it to wall clock at the moment the frame is
 * RECEIVED, §7.4, never assuming agent/browser clocks agree). Absent ⇒ load feature off / not
 * sampled yet (print/json sessions, pre-activation) — byte-equal to the pre-feature shape.
 */
export interface LoadGateWire {
  gating: boolean;
  level: LoadLevelWire;
  sinceAgoMs?: number;
  at: number;
}

/**
 * web-hub-steer-recall plan §2.3 S2: why a held web steer/followUp is sitting in the agent-side
 * buffer instead of having been handed to pi (recallable — `POST /api/cmd {op:"recall"}` returns
 * the full text). `text` is the projection clip (≤ HELD_CLIP_CHARS UTF-16 units, clipped on a
 * code-point boundary); the full text only ever comes back through a recall result. `sessionId`
 * scopes the row: held rows are always the CURRENT session's; returned rows may carry an older
 * session's id (the projection spans every returned item of the process) — the UI's Y2 merge
 * scope is `{agentKey, sessionId, heldEpoch}`.
 */
export type HeldReturnReason = "aborted" | "session" | "reload" | "stale";
export const HELD_WIRE_MAX_ITEMS = 32;
export const HELD_CLIP_CHARS = 200;
export const RECALL_TEXT_MAX_BYTES = 48 * 1024;
export interface HeldItemWire {
  cmdId: string;
  text: string; // ≤ HELD_CLIP_CHARS UTF-16 units, clipped on a code-point boundary
  deliver: "steer" | "followUp";
  state: "held" | "returned";
  reason?: HeldReturnReason; // present iff state === "returned"
  sessionId: string;
  at: number;
}

/** cache-keepalive-web plan §2: one line-breaker row. Open schema (additionalProperties:true). */
export interface CacheKeepaliveLineWire {
  label: string;
  open: boolean;
  status?: number;
  trips: number;
  retryAt?: number;
  current?: true;
  wildcard?: true;
}
/** cache-keepalive-web plan §2: last keepalive ping outcome. `kind` is an open string. */
export interface CacheKeepaliveLastPingWire {
  at: number;
  kind: string;
  status?: number;
  transient?: boolean;
  attempts?: number;
}
/** cache-keepalive-web plan §2/D11: `StatusInfo.cacheKeepalive` body. Deliberately has no `armed`. */
export interface CacheKeepaliveWire {
  v: 1;
  at: number;
  mode: string;
  dirty?: true;
  enabled: boolean;
  modeText?: string;
  ping?: { text: string; state: string; retryAt?: number; tail?: string };
  window: { pings: number; max: number };
  session: {
    pings: number;
    cacheReadTokens: number;
    costUsd?: number;
    avoidedMissTokens: number;
    loadBearingWindows: number;
    unnecessaryWindows: number;
    discardedWindows: number;
  };
  lastPing?: CacheKeepaliveLastPingWire;
  disabled?: { reason: string; at: number; httpStatus?: number; transient?: true };
  lines: CacheKeepaliveLineWire[];
  omitted?: number;
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
  /** quota-web plan §1/D4 (包 quota-web): optional subscription-quota summary (per-provider
   *  5h/7d ladder verdicts), riding the same status slot lifecycle as `todo`/`worktrees`/
   *  `bashJobs`. Absent = no credentials / quota feature off / `webHub.quota` off / not yet
   *  sampled (byte-equal to the pre-feature shape). Decode side stays open-ended (same as `todo`). */
  quota?: QuotaWire;
  /** sysload plan §6.2/§10 包注 P0·M9: this SESSION's own §5.3 effective load-gate verdict,
   *  riding the same status slot lifecycle as `todo`/`worktrees`/`bashJobs`/`quota`. Absent = load
   *  feature off / not sampled yet / print-json session (byte-equal to the pre-feature shape). */
  loadGate?: LoadGateWire;
  /** cache-keepalive-web plan §2: optional prompt-cache keepalive summary (main session), riding the
   *  same status slot lifecycle as `todo`/`worktrees`/`bashJobs`/`quota`. Absent = web-hub off /
   *  cacheTtl.keepalive off / nothing to report (byte-equal to the pre-feature shape). Decode side stays open. */
  cacheKeepalive?: CacheKeepaliveWire;
  /** web-hub-steer-recall plan §2.3 S2: held (recallable) + returned web steer/followUp rows
   *  (≤ HELD_WIRE_MAX_ITEMS), riding the same status slot lifecycle as `todo`/`worktrees`. Absent
   *  ⇔ empty / steerRecall off / holdWired false — byte-equal to the pre-feature shape. Deliberately
   *  NOT gated on holdCap() (plan D3): the StatusInfoSchema is open-ended, so an old hub passes the
   *  frame through untouched and the browser keeps its `unavailable` snapshot across disconnects. */
  held?: HeldItemWire[];
  /** Monotonic per agent process (bumps on every buffer mutation); present iff `held` present.
   *  Only comparable inside one merge scope — see `heldEpoch`. */
  heldRev?: number;
  /** steer-recall R-C/Y2 merge scope: MODULE_INSTANCE of the publishing activate() (same value as
   *  CtlFrame.epoch and the hello epoch on the AgentCard). The UI only accepts a `status.held`
   *  snapshot whose `heldEpoch` equals the CURRENT AgentCard.epoch (and whose rows match the current
   *  sessionId); a mismatched scope is dropped without comparing revs (epochs are random, not
   *  ordered). Present iff `held` present. */
  heldEpoch?: string;
}

export interface FleetRowWire {
  runId: string;
  label?: string;
  type?: string;
  model?: string;
  /** M-B2 (thinking-level visibility): the run's effective thinking level
   *  ("off" | "low" | …). Append-only optional field — no proto bump; absent
   *  ⇔ unknown, and old hubs/UIs ignore it. Rendered next to the model as a
   *  small muted `·<level>` token. */
  thinking?: string;
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
} // payload 只校验 type + 大小；tool_execution_start 可选携带 `startedAt`（agent 钟 epoch
// ms），tool_execution_end 可选携带 `durationMs`（end−start，≥0，有限）—— 均为 append-only
// 扩展字段，旧 hub/UI 无感（WireEventSchema additionalProperties:true，hub 原样转发）。

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
  /** web-hub-session-switch plan §1.2 D2-7: the session identity read in the SAME tick as
   *  `leafId` — the hub forwards it on the history payload so the browser can drop in-flight
   *  snapshots of a session that was replaced mid-flight. Optional by design: an old agent
   *  never sends it and old/new peers mix freely during the rollout window. */
  sessionId?: string;
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
  "prompt" | "abort" | "steer_subagent" | "abort_subagent" | "dialog_answer" | "dialog_cancel" | "command" | "recall";

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
  /** Per-question skip (ask_user 「我可以不回答这个问题」): additive; when true the answer
   *  carries no selected/other and the question comes back to the model as skipped:true. */
  skipped?: boolean;
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
  | { op: "command"; name: string; args: string; confirm?: true; deliver?: "steer" | "followUp"; expect?: CmdExpect }
  | { op: "recall"; target: string };
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
export type PromptDelivery = "observed" | "unobserved" | "held";
/** Result of agent-side @mention routing. This is additive to the prompt result so older
 * hubs/UIs continue to accept and ignore it. */
export type MentionResultData =
  { action: "steer" | "resume"; label: string; runId: string } | { action: "error"; label: string; error: string };
/** web-hub-steer-recall plan §2.3 S2 / §5.8: the typed result of a `recall` op. `text` is the
 *  FULL recalled message body (≤ RECALL_TEXT_MAX_BYTES, hub-validated) — the only channel that
 *  ever returns the untruncated text. `too_late` never distinguishes WHY (already handed to pi /
 *  recalled by another tab — ruling Q5); `from` tells the UI whether the row was still `held` or
 *  already `returned` when the recall landed. */
export type RecallResultData =
  | { op: "recall"; outcome: "recalled"; from: "held" | "returned"; deliver: "steer" | "followUp"; text: string }
  | { op: "recall"; outcome: "too_late" };
export type CmdData =
  | { op: "prompt"; delivery: PromptDelivery; behavior?: "idle" | "steer" | "followUp"; mention?: MentionResultData }
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
  | { op: "query"; state: "running" | "ok" | "failed"; late?: true; result?: CmdResultBody }
  | RecallResultData;
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
    | "late_failed"
    | "held"
    | "recalled"
    | "returned";
  behavior?: "idle" | "steer" | "followUp";
  reason?: "unobserved" | "not-started" | "not-delivered" | "session" | "timeout" | "aborted" | "reload" | "stale";
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
  /** spawn-restore §9.3: on a `shutdown{reason:"restart"}` ack only — how many managed records
   * the hub tagged for restore (`eligibleAtShutdown`), so the TUI can say "N 个网页会话将在
   * hub 重启后恢复". Absent on stop acks, older hubs, and when spawn is off. */
  restoreCount?: number;
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
// todo-archive plan v2.1 §2 (D5): the two optional fields ride the SAME closed schema (kept
// `additionalProperties:false` — an open schema would let a typo'd field slip through to every
// peer); the compat story is the `todo.archive.v1` hub cap instead of schema openness (an old
// hub never receives the new fields, plan §4). Exported for tests/web-hub/protocol tests.
export const TodoWireSchema = Type.Object(
  {
    tasks: Type.Array(TodoTaskSchema),
    total: Type.Integer(),
    counts: Type.Object(
      { open: Type.Integer(), inProgress: Type.Integer(), completed: Type.Integer(), blocked: Type.Integer() },
      { additionalProperties: false },
    ),
    omitted: Type.Optional(Type.Integer()),
    completedHidden: Type.Optional(Type.Integer({ minimum: 0 })),
    archived: Type.Optional(Type.Integer({ minimum: 0 })),
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
// quota-web plan §1/D4: same open posture as WorktreesWireSchema/BashJobsWireSchema above (Q4
// precedent) — a `decodeWith` failure drops the WHOLE status frame.
const QuotaWindowSchema = Type.Object(
  {
    scope: Type.Union([Type.Literal("5h"), Type.Literal("week"), Type.Literal("month")]),
    usedPct: Type.Number({ minimum: 0, maximum: 100 }),
    level: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    resetAt: Type.Optional(Type.Number()),
    etaMs: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);
const QuotaBillingSchema = Type.Object(
  {
    overage: Type.Union([Type.Literal("droidCore"), Type.Literal("extraUsage"), Type.Literal("off")]),
    extraUsageBalanceCents: Type.Integer({ minimum: 0 }),
    gateOpen: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: true },
);
const QuotaProviderSchema = Type.Object(
  {
    id: Type.Union([
      Type.Literal("zai-coding-cn"),
      Type.Literal("zai"),
      Type.Literal("kimi-coding"),
      Type.Literal("droid-standard"),
      Type.Literal("droid-core"),
    ]),
    plan: Type.Optional(Type.String({ maxLength: 64 })),
    level: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    stale: Type.Boolean(),
    fetchedAt: Type.Optional(Type.Number()),
    demotedUntil: Type.Optional(Type.Number()),
    windows: Type.Array(QuotaWindowSchema, { maxItems: 8 }),
    billing: Type.Optional(QuotaBillingSchema),
  },
  { additionalProperties: true },
);
export const QuotaWireSchema = Type.Object(
  {
    v: Type.Literal(1),
    at: Type.Number({ minimum: 0 }),
    providers: Type.Array(QuotaProviderSchema, { maxItems: 16 }),
    problems: Type.Optional(
      Type.Array(
        Type.Object(
          { family: Type.Literal("droid"), status: Type.Integer({ minimum: 100, maximum: 599 }) },
          { additionalProperties: true },
        ),
        { maxItems: 4 },
      ),
    ),
  },
  { additionalProperties: true },
);
// sysload plan §6.2/§10 包注 P0·M9: same open posture as QuotaWireSchema above — a `decodeWith`
// failure drops the whole status frame.
const LoadLevelWireSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("warn"),
  Type.Literal("crit"),
  Type.Literal("unknown"),
]);
export const LoadGateWireSchema = Type.Object(
  {
    gating: Type.Boolean(),
    level: LoadLevelWireSchema,
    sinceAgoMs: Type.Optional(Type.Number({ minimum: 0 })),
    at: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: true },
);
// web-hub-steer-recall plan §2.3 S2': the held-row body rides the open StatusFrameSchema (same
// posture as todo/worktrees/bashJobs/quota — an older hub must pass the newer frame through), but
// the nested row itself is pinned (additionalProperties:false, same as QueueItemSchema/TodoTask):
// the row set is small, frozen by the plan, and a typo'd key means a broken projection, not a
// forward-compat evolution. maxItems 32 = HELD_WIRE_MAX_ITEMS; text maxLength 200 counts UTF-16
// units, matching the projection's HELD_CLIP_CHARS clip.
const HeldItemSchema = Type.Object(
  {
    cmdId: Type.String({ pattern: "^[A-Za-z0-9_-]{16,64}$" }),
    text: Type.String({ maxLength: 200 }),
    deliver: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
    state: Type.Union([Type.Literal("held"), Type.Literal("returned")]),
    reason: Type.Optional(
      Type.Union([Type.Literal("aborted"), Type.Literal("session"), Type.Literal("reload"), Type.Literal("stale")]),
    ),
    sessionId: Type.String(),
    at: Type.Number(),
  },
  { additionalProperties: false },
);
// cache-keepalive-web plan §2 (P0 freeze): same open posture as QuotaWireSchema — a `decodeWith`
// failure drops the whole status frame, so the boundary is deliberately wider than the projection.
// `mode`/`ping.state`/`lastPing.kind` are open strings (never Union<Literal>).
const CKStr = (maxLength = 256) => Type.String({ maxLength });
const CacheKeepaliveLineWireSchema = Type.Object(
  {
    label: CKStr(),
    open: Type.Boolean(),
    status: Type.Optional(Type.Number()),
    trips: Type.Number(),
    retryAt: Type.Optional(Type.Number()),
    current: Type.Optional(Type.Literal(true)),
    wildcard: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: true },
);
export const CacheKeepaliveWireSchema = Type.Object(
  {
    v: Type.Literal(1),
    at: Type.Number(),
    mode: CKStr(),
    dirty: Type.Optional(Type.Literal(true)),
    enabled: Type.Boolean(),
    modeText: Type.Optional(CKStr()),
    ping: Type.Optional(
      Type.Object(
        {
          text: CKStr(),
          state: CKStr(),
          retryAt: Type.Optional(Type.Number()),
          tail: Type.Optional(CKStr()),
        },
        { additionalProperties: true },
      ),
    ),
    window: Type.Object({ pings: Type.Number(), max: Type.Number() }, { additionalProperties: true }),
    session: Type.Object(
      {
        pings: Type.Number(),
        cacheReadTokens: Type.Number(),
        costUsd: Type.Optional(Type.Number()),
        avoidedMissTokens: Type.Number(),
        loadBearingWindows: Type.Number(),
        unnecessaryWindows: Type.Number(),
        discardedWindows: Type.Number(),
      },
      { additionalProperties: true },
    ),
    lastPing: Type.Optional(
      Type.Object(
        {
          at: Type.Number(),
          kind: CKStr(),
          status: Type.Optional(Type.Number()),
          transient: Type.Optional(Type.Boolean()),
          attempts: Type.Optional(Type.Number()),
        },
        { additionalProperties: true },
      ),
    ),
    disabled: Type.Optional(
      Type.Object(
        {
          reason: CKStr(),
          at: Type.Number(),
          httpStatus: Type.Optional(Type.Number()),
          transient: Type.Optional(Type.Literal(true)),
        },
        { additionalProperties: true },
      ),
    ),
    lines: Type.Array(CacheKeepaliveLineWireSchema, { maxItems: 32 }),
    omitted: Type.Optional(Type.Number()),
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
  quota: Type.Optional(QuotaWireSchema),
  loadGate: Type.Optional(LoadGateWireSchema),
  cacheKeepalive: Type.Optional(CacheKeepaliveWireSchema),
  // web-hub-steer-recall plan §2.3 S2'
  held: Type.Optional(Type.Array(HeldItemSchema, { maxItems: 32 })),
  heldRev: Type.Optional(Type.Integer({ minimum: 0 })),
  heldEpoch: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});

const FleetRowSchema = Type.Object({
  runId: Type.String(),
  label: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  // M-B2 (thinking-level visibility): display-only token, same lenient posture as
  // `model` above — never length-bounded here, because one odd value must not make
  // the whole fleet frame / snapshot_reply fail to decode. The agent-side projection
  // (agent/status.ts) drops empty or oversized values instead.
  thinking: Type.Optional(Type.String()),
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
  // D2-7 (web-hub-session-switch plan §2.2 step 4): optional, additive — no proto bump (same
  // precedent as the todo/worktrees StatusInfo slots). The schema is open, so an old hub
  // receiving a frame carrying it is unaffected.
  sessionId: Type.Optional(Type.String()),
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
  {
    selected: Type.Array(Type.String()),
    other: Type.Union([Type.String(), Type.Null()]),
    skipped: Type.Optional(Type.Boolean()),
  },
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
// web-hub-steer-recall plan §2.3 S2': recall joins the CLOSED CmdSchema union — the target is a
// cmdId (same pattern as the frame id), and NOTHING else may ride the op (no expect, no text:
// recall identifies by id only; the full text comes back in the typed result).
const RecallArgsSchema = Type.Object(
  { op: Type.Literal("recall"), target: Type.String({ pattern: "^[A-Za-z0-9_-]{16,64}$" }) },
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
      RecallArgsSchema,
    ]),
  },
  { additionalProperties: false },
);
const CmdDataSchema = Type.Unknown();
// web-hub-steer-recall plan §2.3 S2' / §5.8: recall is the one op whose success payload the HUB
// re-validates (hub/commands.ts, S4) — `CmdDataSchema` stays `Type.Unknown()` (cmd_result remains
// generic), this schema is the typed boundary applied on the recall execution/queryOnly paths.
// `text` carries the FULL recalled body; the hub additionally enforces the 48 KiB byte cap
// (RECALL_TEXT_MAX_BYTES) before trusting it.
export const RecallResultDataSchema = Type.Union([
  Type.Object(
    {
      op: Type.Literal("recall"),
      outcome: Type.Literal("recalled"),
      from: Type.Union([Type.Literal("held"), Type.Literal("returned")]),
      deliver: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
      text: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ op: Type.Literal("recall"), outcome: Type.Literal("too_late") }, { additionalProperties: false }),
]);
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
      Type.Literal("recall"),
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
      Type.Literal("held"),
      Type.Literal("recalled"),
      Type.Literal("returned"),
    ]),
    behavior: Type.Optional(Type.Union([Type.Literal("idle"), Type.Literal("steer"), Type.Literal("followUp")])),
    reason: Type.Optional(
      Type.Union([
        Type.Literal("unobserved"),
        Type.Literal("not-started"),
        Type.Literal("not-delivered"),
        Type.Literal("session"),
        Type.Literal("timeout"),
        Type.Literal("aborted"),
        Type.Literal("reload"),
        Type.Literal("stale"),
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
