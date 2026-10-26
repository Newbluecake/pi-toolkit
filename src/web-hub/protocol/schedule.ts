/**
 * Scheduled tasks (docs/dev/scheduled-reports/plan.md r3) — S0 FROZEN wire contract.
 *
 * What lives here (and why here, not in `src/schedule/core/spec.ts`):
 *   - the `sched.v1` cap constants (§10.1);
 *   - the five `sched_*` agent↔hub frames — typebox schemas (strict, `additionalProperties:false`)
 *     plus the authoritative TS interfaces, folded into `messages.ts`'s unions/decode tables;
 *   - the wire-level id/hash vocabulary (task id, runKey, defHash, reportId, reqId) that BOTH the
 *     hub and the agent validate against;
 *   - the task-definition / run-state vocabulary types — the hub projection (§5.6) carries them,
 *     and `src/web-hub/{protocol,hub}/**` may only import inside protocol/hub
 *     (`tests/web-hub/boundary.test.ts`), so the shared shapes must originate here;
 *     `spec.ts` re-exports them as the storage spec's own names;
 *   - `HubConfig.schedule`'s shape + its `hub/main.ts` normalizer (§10.3);
 *   - the hub projection shapes H1 produces and W1 consumes (§5.6, TS only).
 *
 * S0 ships declarations + pure helpers only: nothing folds the cap into any caps array, nothing
 * routes the frames, nothing writes `HubConfig.schedule` (A0/H1 own that). No PROTO bump — new
 * optional frames sent only under the cap (same 只加帧不改 rule as fsb_req / complete_req / xs_*).
 *
 * Boundary: node:*-free, pi-free, DOM-free — typebox only. This module must never value-import
 * `messages.js` (messages.ts imports the schemas from here at top level; TDZ — run-transcript
 * precedent).
 */
import { Type, type TSchema } from "@sinclair/typebox";

// ----------------------------------------------------------------- caps (§10.1)

/** Hub-side cap: advertised on BOTH hub cap surfaces (`HubInfo.caps` / `hello_ack.caps`) iff
 *  `HubConfig.schedule` exists (key absence IS off). Folded by H1 — inert in S0. */
export const SCHED_HUB_CAP = "sched.v1";
export const SCHED_HUB_CAPS = [SCHED_HUB_CAP] as const;
/** Agent-side cap: advertised in `hello.caps` iff `schedule.enabled` (A0). The agent sends
 *  `sched_*` frames ONLY while the live link's `hello_ack.caps ∋ sched.v1`; otherwise it uses the
 *  NullCoordinator (does nothing, persists nothing). */
export const SCHED_AGENT_CAP = "sched.v1";
export const SCHED_AGENT_CAPS = [SCHED_AGENT_CAP] as const;

// ----------------------------------------------------------------- ids / hashes (§4.1/§4.2/§4.5/§7.1/§7.4)

/** Task id: `"s_" + base32(8)` — RFC 4648 base32 alphabet, lowercase (a–z, 2–7). */
export const SCHED_TASK_ID_RE = /^s_[a-z2-7]{8}$/;
/** sha256, full 64 lowercase hex — `defHash` (§4.1) and `reportId` (§4.2.1) share this shape. */
export const SCHED_HASH_RE = /^[0-9a-f]{64}$/;
/** runKey: auto `<taskId>@<T>` (T = UTC epoch ms, decimal, no sign/leading zeros except "0");
 *  manual `<taskId>@m-<hash8(reqId)>` (first 8 hex of sha256(reqId), §4.5b). */
export const SCHED_RUN_KEY_RE = /^s_[a-z2-7]{8}@(?:0|[1-9][0-9]{0,15}|m-[0-9a-f]{8})$/;
/** reqId for manual runs: the web command op's cmdId or the Feishu request's deterministic
 *  `fs…` cmdId — both `^[A-Za-z0-9_-]{16,64}$` (same shape as `CmdFrame.id`). */
export const SCHED_REQ_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** pi sessionId as carried on the wire (bounded; directory sanitizing is S1's job). */
export const SCHED_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `sched_receipts.reportIds` per-frame cap (§10.1). Larger batches are split by the hub. */
export const SCHED_RECEIPTS_PER_FRAME = 64;
/** Static reason vocabulary length cap on the wire (`sched_run_ack.reason`, projection reasons). */
export const SCHED_REASON_MAX_CHARS = 128;

// ----------------------------------------------------------------- definition vocabulary (§4.1)

export type ScheduleForm = "background" | "message";
export const SCHEDULE_FORMS = ["background", "message"] as const;

/** `tz` is part of the definition (IANA name, validated with Intl by S1). `once.at` is a LOCAL
 *  wall-clock `"YYYY-MM-DDTHH:mm"` interpreted in `tz`. */
export type ScheduleWhen = { kind: "cron"; expr: string; tz: string } | { kind: "once"; at: string; tz: string };

/** Subagent-surface thinking levels — literal mirror of `core/types.ts`'s THINKING_LEVELS
 *  (protocol cannot import core; parity pinned by tests/schedule/core/spec.test.ts). */
export type ScheduleThinkingLevel = "off" | "low" | "medium" | "high";
export const SCHEDULE_THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

export interface ScheduleBg {
  /** AgentTypeName; default "general-purpose" (validated against the registry at create time). */
  type: string;
  /** Strict provider/id → SpawnRequest.modelOverride. */
  model?: { provider: string; id: string };
  thinking?: ScheduleThinkingLevel;
  /** Seconds; default `schedule.defaultTimeoutS`, ≤ `schedule.maxTimeoutS` (hard ≤ 14400). */
  timeoutS: number;
  consultMain: boolean;
  handoff: boolean;
  isolation?: "worktree";
}

export interface ScheduleApproval {
  /** Equals `defHash(task)` at approval time; executable ⇔ still equal (S2). */
  hash: string;
  by: "user";
  via: "tui" | "web";
  at: number;
}

/** The task definition (§4.1). `spec.ts` re-exports this as `ScheduleTask`. */
export interface ScheduleTaskDef {
  id: string;
  name: string;
  form: ScheduleForm;
  when: ScheduleWhen;
  prompt: string;
  feishu: boolean;
  /** Present iff `form === "background"` (validation rule, S1/A3). */
  bg?: ScheduleBg;
  enabled: boolean;
  approval?: ScheduleApproval;
  createdBy: "user" | "agent";
  createdVia: "tui" | "web" | "tool";
  createdAt: number;
  /** Canonical cwd at creation (§11 vault checks). Part of the execution definition. */
  ownerCwd: string;
}

// ----------------------------------------------------------------- run vocabulary (§4.2/§6.1/§6.2)

export const SCHEDULE_RUN_STATES = [
  // background non-terminal
  "dispatching",
  "running",
  // message / handoff non-terminal
  "queued",
  "dispatched",
  "bound",
  "aborting",
  // background terminal — 1:1 with RunOutcome.status
  "completed",
  "failed",
  "timed_out",
  "aborted",
  // admission failure (terminal)
  "refused",
  // message / handoff terminal
  "settled",
  "continued",
  // shared terminal
  "unknown",
  "dropped",
] as const;
export type ScheduleRunState = (typeof SCHEDULE_RUN_STATES)[number];
export const SCHEDULE_NON_TERMINAL_RUN_STATES = [
  "dispatching",
  "running",
  "queued",
  "dispatched",
  "bound",
  "aborting",
] as const satisfies readonly ScheduleRunState[];

export type ScheduleRunKind = "auto" | "manual";

/** Hub receipt states for a report (§7.1). Every one of them makes `sched_receipts` carry the
 *  reportId (the agent then drops the pendingReports entry). */
export const SCHEDULE_RECEIPT_STATES = ["accepted", "sent", "failed", "uncertain", "refused"] as const;
export type ScheduleReceiptState = (typeof SCHEDULE_RECEIPT_STATES)[number];

/** Panel / `/schedule log` display of a run's Feishu delivery (§7.1 状态区分):
 *  `none` = not a pushed report; `n/a` = bot never configured; `waiting` = creds present but not
 *  open (or not yet picked up); `expired` = 24h window passed; `?` = hub unreachable (agent-side
 *  rendering only — the hub never emits it). */
export type ScheduleFeishuDisplay = ScheduleReceiptState | "none" | "n/a" | "waiting" | "expired" | "?";

// ----------------------------------------------------------------- frames (§10.1)

/** agent→hub: nudge — rescan just this session's state.json. */
export interface SchedChangedFrame {
  t: "sched_changed";
  sessionId: string;
}
/** agent→hub: the scheduler's message reached `bound` (message_start) for `agentKey`'s current
 *  run — same ordered socket as `ev`, so it lands between that run's agent_start/agent_settled (§7.5). */
export interface SchedBoundFrame {
  t: "sched_bound";
  agentKey: string;
  runKey: string;
}
/** agent→hub: answer to `sched_run` (exactly one per received, unexpired sched_run). */
export interface SchedRunAckFrame {
  t: "sched_run_ack";
  reqId: string;
  result: "started" | "refused";
  /** Static code (e.g. `E_UNAPPROVED`, `E_OVERLAP`, `E_REV`, `expired`); refused only by convention. */
  reason?: string;
}
/** hub→agent: Feishu `/schedule run <n>` (§7.4). The agent refuses on sessionId mismatch or
 *  `now > expiresAt`, dedups by `reqId` in `manualReqs`, and requires `defHash` to equal both the
 *  current definition hash and the approval hash. */
export interface SchedRunFrame {
  t: "sched_run";
  reqId: string;
  sessionId: string;
  taskId: string;
  defHash: string;
  expiresAt: number;
}
/** hub→agent: these reports reached a receipt state; drop them from `pendingReports` (§4.2.1/§7.1).
 *  ≤ SCHED_RECEIPTS_PER_FRAME ids per frame. */
export interface SchedReceiptsFrame {
  t: "sched_receipts";
  sessionId: string;
  reportIds: string[];
}

// ----------------------------------------------------------------- confirm offers (#61, sched.confirm.v1)

/** Both sides use this cap string; hub advertises it when HubConfig.schedule exists, agent when a schedule port exists. */
export const SCHED_CONFIRM_CAP = "sched.confirm.v1";
/** Open offers per session (agent evicts the oldest). */
export const SCHED_CONFIRM_OFFERS_MAX = 8;
/** Closed echo entries per `sched_offers` frame. */
export const SCHED_CONFIRM_CLOSED_MAX = 8;
/** Offer lifetime (constant, not a setting). */
export const SCHED_CONFIRM_TTL_MS = 2 * 3_600_000;
/** `sched_decide.expiresAt = now + 30 s`. */
export const SCHED_DECIDE_TTL_MS = 30_000;
export const SCHED_DECIDE_ACK_WAIT_MS = 10_000;

export const SCHED_OFFER_OUTCOMES = ["approved", "rejected", "superseded", "expired", "withdrawn"] as const;
export type SchedOfferOutcome = (typeof SCHED_OFFER_OUTCOMES)[number];
export const SCHED_OFFER_BYS = ["tui", "web", "feishu", "elsewhere"] as const;
export type SchedOfferBy = (typeof SCHED_OFFER_BYS)[number];

export interface SchedOfferWire {
  offerId: string;
  taskId: string;
  defHash: string;
  expiresAt: number;
}
export interface SchedOfferClosedWire {
  offerId: string;
  taskId: string;
  defHash: string;
  outcome: SchedOfferOutcome;
  /** Who won; "elsewhere" = ledger approved outside the confirm flow (web command / --all / other process / after reload). */
  by?: SchedOfferBy;
}
/** agent→hub: authoritative full list of this session's offers (every change + every hello_ack; empty list too). */
export interface SchedOffersFrame {
  t: "sched_offers";
  sessionId: string;
  open: SchedOfferWire[];
  closed: SchedOfferClosedWire[];
}
/** hub→agent: the Feishu card's decision. */
export interface SchedDecideFrame {
  t: "sched_decide";
  reqId: string;
  sessionId: string;
  offerId: string;
  taskId: string;
  defHash: string;
  decision: "approve" | "reject";
  expiresAt: number;
}
/** agent→hub: exactly one per unexpired `sched_decide`. */
export interface SchedDecideAckFrame {
  t: "sched_decide_ack";
  reqId: string;
  result: "approved" | "rejected" | "refused";
  /** Static reason (E_REV | already-approved | offer-gone | expired | E_NOT_OWNER | E_SECURE | E_DEGRADED | E_BUSY …), ≤128 chars. */
  reason?: string;
}

export type SchedAgentFrame =
  SchedChangedFrame | SchedBoundFrame | SchedRunAckFrame | SchedOffersFrame | SchedDecideAckFrame;
export type SchedHubFrame = SchedRunFrame | SchedReceiptsFrame | SchedDecideFrame;

const strict = { additionalProperties: false } as const;
const SessionIdSchema = Type.String({ pattern: SCHED_SESSION_ID_RE.source, maxLength: 128 });
const ReqIdSchema = Type.String({ pattern: SCHED_REQ_ID_RE.source });
const HashSchema = Type.String({ pattern: SCHED_HASH_RE.source });

export const SchedChangedSchema = Type.Object({ t: Type.Literal("sched_changed"), sessionId: SessionIdSchema }, strict);
export const SchedBoundSchema = Type.Object(
  {
    t: Type.Literal("sched_bound"),
    agentKey: Type.String({ minLength: 1, maxLength: 256 }),
    runKey: Type.String({ pattern: SCHED_RUN_KEY_RE.source }),
  },
  strict,
);
export const SchedRunAckSchema = Type.Object(
  {
    t: Type.Literal("sched_run_ack"),
    reqId: ReqIdSchema,
    result: Type.Union([Type.Literal("started"), Type.Literal("refused")]),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: SCHED_REASON_MAX_CHARS })),
  },
  strict,
);
export const SchedRunSchema = Type.Object(
  {
    t: Type.Literal("sched_run"),
    reqId: ReqIdSchema,
    sessionId: SessionIdSchema,
    taskId: Type.String({ pattern: SCHED_TASK_ID_RE.source }),
    defHash: HashSchema,
    expiresAt: Type.Integer({ minimum: 0 }),
  },
  strict,
);
export const SchedReceiptsSchema = Type.Object(
  {
    t: Type.Literal("sched_receipts"),
    sessionId: SessionIdSchema,
    reportIds: Type.Array(HashSchema, { minItems: 1, maxItems: SCHED_RECEIPTS_PER_FRAME }),
  },
  strict,
);

const OfferIdSchema = ReqIdSchema;
const TaskIdSchema = Type.String({ pattern: SCHED_TASK_ID_RE.source });
const OfferOutcomeSchema = Type.Union(SCHED_OFFER_OUTCOMES.map((o) => Type.Literal(o)));
const OfferBySchema = Type.Union(SCHED_OFFER_BYS.map((o) => Type.Literal(o)));
export const SchedOfferSchema = Type.Object(
  { offerId: OfferIdSchema, taskId: TaskIdSchema, defHash: HashSchema, expiresAt: Type.Integer({ minimum: 0 }) },
  strict,
);
export const SchedOfferClosedSchema = Type.Object(
  {
    offerId: OfferIdSchema,
    taskId: TaskIdSchema,
    defHash: HashSchema,
    outcome: OfferOutcomeSchema,
    by: Type.Optional(OfferBySchema),
  },
  strict,
);
export const SchedOffersSchema = Type.Object(
  {
    t: Type.Literal("sched_offers"),
    sessionId: SessionIdSchema,
    open: Type.Array(SchedOfferSchema, { maxItems: SCHED_CONFIRM_OFFERS_MAX }),
    closed: Type.Array(SchedOfferClosedSchema, { maxItems: SCHED_CONFIRM_CLOSED_MAX }),
  },
  strict,
);
export const SchedDecideSchema = Type.Object(
  {
    t: Type.Literal("sched_decide"),
    reqId: ReqIdSchema,
    sessionId: SessionIdSchema,
    offerId: OfferIdSchema,
    taskId: TaskIdSchema,
    defHash: HashSchema,
    decision: Type.Union([Type.Literal("approve"), Type.Literal("reject")]),
    expiresAt: Type.Integer({ minimum: 0 }),
  },
  strict,
);
export const SchedDecideAckSchema = Type.Object(
  {
    t: Type.Literal("sched_decide_ack"),
    reqId: ReqIdSchema,
    result: Type.Union([Type.Literal("approved"), Type.Literal("rejected"), Type.Literal("refused")]),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: SCHED_REASON_MAX_CHARS })),
  },
  strict,
);

/** Folded into messages.ts's agent→hub decode table (append-only). */
export const SCHED_AGENT_FRAME_SCHEMAS: Readonly<Record<string, TSchema>> = {
  sched_changed: SchedChangedSchema,
  sched_bound: SchedBoundSchema,
  sched_run_ack: SchedRunAckSchema,
  sched_offers: SchedOffersSchema,
  sched_decide_ack: SchedDecideAckSchema,
};
/** Folded into messages.ts's hub→agent decode table (append-only). */
export const SCHED_HUB_FRAME_SCHEMAS: Readonly<Record<string, TSchema>> = {
  sched_run: SchedRunSchema,
  sched_receipts: SchedReceiptsSchema,
  sched_decide: SchedDecideSchema,
};

/** hub waits at most this long for `sched_run_ack` before replying 「执行结果未确认」 (§7.4). */
export const SCHED_RUN_ACK_WAIT_MS = 10_000;
/** `sched_run.expiresAt = now + SCHED_RUN_TTL_MS` (§7.4). */
export const SCHED_RUN_TTL_MS = 30_000;

// ----------------------------------------------------------------- HubConfig.schedule (§10.3)

/** Fixed online tolerance (s) — `fireToleranceS`, NOT a setting (§10.3). */
export const SCHED_TOLERANCE_S = 60;

/**
 * `HubConfig.schedule`: written ONLY when `schedule.enabled ∧ webHub.enabled ∧ control !== false`
 * (A0's `buildHubConfig`). Key absence IS off ⇒ hub byte-identical (no reader, no cap, no routes,
 * no SSE event, no frame handling).
 */
export interface HubScheduleConfig {
  /** Absolute storeDir (the hub realpaths + vault-checks it at start, §7.6). */
  dir: string;
  toleranceS: typeof SCHED_TOLERANCE_S;
}

/** Max accepted `dir` length (bytes are not checked here — realpath does the real work). */
export const SCHED_DIR_MAX_CHARS = 4096;

/**
 * `hub/main.ts` normalizer (H1 calls it): a fresh, exactly-shaped config, or `undefined` when the
 * value is malformed — the caller then DROPS the whole key (feature off). Unknown extra keys are
 * ignored (forward compat) and never copied.
 */
export function normalizeHubScheduleConfig(input: unknown): HubScheduleConfig | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const r = input as Record<string, unknown>;
  const dir = r["dir"];
  if (typeof dir !== "string" || dir.length === 0 || dir.length > SCHED_DIR_MAX_CHARS) return undefined;
  if (!dir.startsWith("/") || dir.includes("\0")) return undefined;
  if (r["toleranceS"] !== SCHED_TOLERANCE_S) return undefined;
  return { dir, toleranceS: SCHED_TOLERANCE_S };
}

// ----------------------------------------------------------------- hub projection (§5.6) — H1 produces, W1 consumes

/** SSE event name (direct-send, fingerprint-gated, cap `sched.v1`). */
export const SCHED_SSE_EVENT = "schedules";
/** `GET /api/schedules?sessionId=<sid>` (X-PWH: 1; omit sessionId ⇒ all scanned sessions). */
export const SCHED_API_PATH = "/api/schedules";

export interface ScheduleTaskProjectionWire {
  /** Full definition incl. the whole prompt (the review dialog renders it verbatim). */
  task: ScheduleTaskDef;
  defHash: string;
  /** `enabled && approval?.hash === defHash`. */
  executable: boolean;
  /** `approval` missing or `approval.hash !== defHash` (UI 「待确认」). */
  pendingApproval: boolean;
  /** Hub-computed with the shared cron core in `task.when.tz`; absent when disabled/never. */
  nextAt?: number;
  /** `"never"` = no occurrence within the 400-day horizon / budget. */
  degraded?: "never";
  totals: { fired: number; missed: number; skipped: number; manual: number };
  /** #61: open confirm offer for this exact definition (append-only; absent unless one live, matching, unexpired offer). */
  offer?: { offerId: string; expiresAt: number };
}

export interface ScheduleRunProjectionWire {
  runKey: string;
  taskId: string;
  kind: ScheduleRunKind;
  form: ScheduleForm;
  scheduledAt: number;
  state: ScheduleRunState;
  reason?: string;
  runId?: string;
  startedAt: number;
  endedAt?: number;
  /** `reports/<h>.md` relative path, only when a report file exists. */
  reportFile?: string;
  feishu: ScheduleFeishuDisplay;
}

export interface ScheduleSessionProjectionWire {
  sessionId: string;
  rev: number;
  /** Store unreadable/invalid for this session — UI shows 「需在终端 /schedule repair」; tasks/runs empty. */
  degraded?: string;
  tasks: ScheduleTaskProjectionWire[];
  /** Most recent first; non-terminal runs always included. */
  runs: ScheduleRunProjectionWire[];
  /** `reportStats.droppedIndexCap` (§4.2.1). */
  droppedReports?: number;
}

/** Payload of both the SSE `schedules` event and `GET /api/schedules`. H1 may only APPEND
 *  optional fields (W1 must ignore unknown keys). */
export interface SchedulesPayloadWire {
  sessions: ScheduleSessionProjectionWire[];
}
