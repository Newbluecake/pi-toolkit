/**
 * Scheduled tasks — S0 FROZEN storage spec (docs/dev/scheduled-reports/plan.md r3 §4/§10.2).
 *
 * The single-file ledger (`<storeDir>/<sanitize(sid)>/state.json`, S1) and everything that must
 * agree about it: task / run / state-file shapes (incl. `missedLog` and `pendingReports`), the
 * fixed limits, the error-code vocabulary and the canonical `defHash` (S2: approval = definition
 * hash). Pure: imports `node:crypto` plus the wire vocabulary of `protocol/schedule.ts` (the task
 * definition / run-state types originate there because the hub projection carries them and
 * protocol/hub may not import outside themselves — see that module's header). Nothing here does
 * IO, reads a clock or touches pi.
 *
 * defHash canonicalization (§4.1, frozen — changing ANY rule below invalidates every stored
 * approval; it needs a new version of the whole state file, never an in-place edit):
 *   1. Execution definition = exactly the fields `form, when, prompt, feishu, bg, ownerCwd` of the
 *      task (`name`, `enabled`, `approval`, `id`, `created*` never participate). `bg` is taken
 *      whole (every present field), absent when the task has none.
 *   2. canonicalJson: object keys sorted ascending by UTF-16 code unit (`Array.prototype.sort`'s
 *      default comparator); properties whose value is `undefined` are dropped; arrays keep order;
 *      strings/numbers/booleans/null serialize exactly as `JSON.stringify` does; no whitespace.
 *      Non-finite numbers, bigint, functions, symbols and non-plain objects throw (a definition
 *      that cannot be canonicalized can never be approved). Strings are NOT Unicode-normalized —
 *      the hash binds the exact code points the user reviewed.
 *   3. defHash = lowercase hex sha256 of the UTF-8 bytes of that string (64 chars).
 * Test vectors: tests/schedule/core/spec.test.ts.
 */
import { createHash } from "node:crypto";
import {
  SCHED_HASH_RE,
  SCHED_RUN_KEY_RE,
  SCHED_TASK_ID_RE,
  SCHED_TOLERANCE_S,
  SCHEDULE_NON_TERMINAL_RUN_STATES,
  type ScheduleForm,
  type ScheduleRunKind,
  type ScheduleRunState,
  type ScheduleTaskDef,
} from "../../web-hub/protocol/schedule.js";

export type {
  ScheduleApproval,
  ScheduleBg,
  ScheduleForm,
  ScheduleReceiptState,
  ScheduleRunKind,
  ScheduleRunState,
  ScheduleThinkingLevel,
  ScheduleWhen,
} from "../../web-hub/protocol/schedule.js";
export {
  SCHED_HASH_RE,
  SCHED_RUN_KEY_RE,
  SCHED_TASK_ID_RE,
  SCHEDULE_FORMS,
  SCHEDULE_RECEIPT_STATES,
  SCHEDULE_RUN_STATES,
  SCHEDULE_THINKING_LEVELS,
} from "../../web-hub/protocol/schedule.js";

/** The task definition (§4.1). Same shape as the wire `ScheduleTaskDef`. */
export type ScheduleTask = ScheduleTaskDef;
export type TaskId = string;
export type ReqId = string;

// ----------------------------------------------------------------- fixed values (§4.4/§4.7/§10.3 — NOT settings)

/** Online fire tolerance (§4.4): claim executes T only while `now ≤ T + tol`; sweep cut = now − tol. */
export const SCHED_FIRE_TOLERANCE_MS = SCHED_TOLERANCE_S * 1000;
/** Message / handoff main-session run cap (N2): authorizedAt + 3600s ⇒ abort; human input lifts it. */
export const SCHED_RUN_MAX_MS = 3_600_000;
/** Dispatcher start timeout (§6.2): sentAt + 60s. */
export const SCHED_START_TIMEOUT_MS = 60_000;
/** Dispatcher quiet period after `agent_settled` (§6.2). */
export const SCHED_QUIET_MS = 1_000;
/** `unknown` capability evidence older than this degrades queued messages (§6.2). */
export const SCHED_CAPABILITY_UNKNOWN_MAX_MS = 30 * 60_000;

export const SCHED_MAX_TASKS_PER_SESSION = 8;
export const SCHED_MAX_SESSION_DIRS = 64;
/** Task name cap, UTF-16 code units. */
export const SCHED_NAME_MAX_CHARS = 40;
/** Prompt cap, UTF-8 bytes. */
export const SCHED_PROMPT_MAX_BYTES = 8 * 1024;
/** background timeoutS default / bounds (seconds). Mirrored literally by settings.ts. */
export const SCHED_BG_TIMEOUT_DEFAULT_S = 1800;
export const SCHED_BG_TIMEOUT_MIN_S = 60;
export const SCHED_BG_TIMEOUT_MAX_S = 14_400;
export const SCHED_BG_DEFAULT_TYPE = "general-purpose";

/** state.json byte cap. */
export const SCHED_STATE_MAX_BYTES = 256 * 1024;
/** Terminal runs kept per task (UI history only; non-terminal runs are never evicted). */
export const SCHED_RUNS_PER_TASK = 20;
/** pendingReports cap per session; overflow drops the OLDEST entry (§4.2.1). */
export const SCHED_PENDING_REPORTS_MAX = 64;
/** missedLog entries kept per task (missedTotal is cumulative regardless). */
export const SCHED_MISSED_LOG_MAX = 64;
export const SCHED_MANUAL_REQS_MAX = 32;
export const SCHED_MANUAL_REQ_TTL_MS = 24 * 3_600_000;
/** N1: reports are pushed only within 24h of `endedAt` (`expiresAt = endedAt + this`). */
export const SCHED_REPORT_MAX_AGE_MS = 24 * 3_600_000;
export const SCHED_REPORT_MAX_BYTES = 256 * 1024;
export const SCHED_REPORT_RETENTION_MS = 14 * 24 * 3_600_000;
export const SCHED_REPORTS_PER_SESSION_MAX = 200;
export const SCHED_REPORT_BYTES_PER_SESSION_MAX = 8 * 1024 * 1024;
export const SCHED_REPORTS_GLOBAL_MAX = 2_000;
export const SCHED_REPORT_BYTES_GLOBAL_MAX = 128 * 1024 * 1024;
/** Hub receipt table (§7.1): 7 days, ≤ 4096 entries. */
export const SCHED_RECEIPT_TTL_MS = 7 * 24 * 3_600_000;
export const SCHED_RECEIPTS_MAX = 4_096;
/** Session-file proof read cap (§6.3): beyond this the note is `unverified`, never resent. */
export const SCHED_NOTE_PROOF_MAX_BYTES = 16 * 1024 * 1024;
/** Max resends of one note, across distinct processes (§6.3). */
export const SCHED_NOTE_MAX_RESENDS = 2;
/** cron budgets (§4.4). */
export const SCHED_COUNT_CAP = 10_000;
export const SCHED_NEXT_HORIZON_MS = 400 * 24 * 3_600_000;
export const SCHED_NEXT_CANDIDATE_BUDGET = 50_000;
/** Result-message summary cap (§6.3). */
export const SCHED_NOTE_SUMMARY_MAX_BYTES = 4 * 1024;

// ----------------------------------------------------------------- names (frozen strings)

export const SCHED_STATE_FILE = "state.json";
export const SCHED_LOCK_FILE = ".lock";
export const SCHED_REPORTS_DIR = "reports";
/** customType of every scheduler-authored session message (result / digest / message / handoff). */
export const SCHED_CUSTOM_TYPE = "subagent:schedule";
export type SchedMessageKind = "message" | "handoff" | "result" | "digest" | "handoff-recap";
/** TUI status key (§5.4). */
export const SCHED_STATUS_KEY = "pi-subagent:schedule";
/** Prompt-section name (§5.3). */
export const SCHED_SECTION_NAME = "pi_schedules";
/** Process-level dispatcher claim (§6.2). */
export const SCHED_DISPATCH_SYMBOL_KEY = "pi-subagent:sched-dispatch";
/** New short names and legacy reportId names; both remain relative to the session directory. */
export const SCHED_REPORT_NAME_RE = /^(?:[0-9a-f]{64}|s_[a-z2-7]{8}-[0-9]{8}-[0-9]{4}(?:-(?:[2-9]|[1-9][0-9]+))?)\.md$/;
export const SCHED_REPORT_FILE_RE = new RegExp(`^reports/${SCHED_REPORT_NAME_RE.source.slice(1)}`);

// ----------------------------------------------------------------- error codes (§10.2)

export const SCHEDULE_ERROR_CODES = [
  "E_DISABLED",
  "E_MODE",
  "E_EPHEMERAL",
  "E_CHILD",
  "E_SECURE",
  "E_LIMIT",
  "E_INVALID",
  "E_REV",
  "E_UNAPPROVED",
  "E_NOT_OWNER",
  "E_OVERLAP",
  "E_BUSY",
  "E_DEGRADED",
  "E_UNSUPPORTED",
] as const;
export type ScheduleErrorCode = (typeof SCHEDULE_ERROR_CODES)[number];

// ----------------------------------------------------------------- state file (§4.2)

/** Process identity of a run / note / digest holder. `epoch` is random per stack build. */
export interface Holder {
  pid: number;
  /** /proc starttime (clock ticks since boot). */
  start: number;
  host: string;
  /** Kernel boot id. */
  boot: string;
  epoch: string;
}

export type MissedCause = "offline" | "late" | "once-past";

export interface MissedEntry {
  /** Per-task monotone. */
  seq: number;
  /** Definition version the verdict used. */
  defHash: string;
  /** Interval left end (exclusive). */
  from: number;
  /** Interval right end (inclusive): every occurrence of `defHash` in (from, to] was missed. */
  to: number;
  /** = countOccurrences(def, from, to) — the ONE shared counter (S1), also used by the hub. */
  count: number;
  /** missedTotal after appending this entry (truncation reconciliation, §7.2). */
  totalAfter: number;
  at: number;
  cause: MissedCause;
}

export interface OccState {
  defHash: string;
  /** Auto-occurrence decided watermark (UTC epoch ms), monotone non-decreasing. */
  decidedThrough: number;
  /** Auto fires only (manual never counted, §4.5b). */
  firedTotal: number;
  /** = Σ missedLog.count incl. truncated entries; never reset. */
  missedTotal: number;
  /** Overlap skips + D13 coalescing. */
  skippedTotal: number;
  /** Most recent ≤ SCHED_MISSED_LOG_MAX entries. */
  missedLog: MissedEntry[];
}

export type NoteState = "none" | "pending" | "written" | "unverified";

/** Known `RunRecord.reason` vocabulary (static strings; the field itself stays `string` so
 *  `admission:<code>` / `stopCause` / `error.kind` / `timeoutReason` values fit). */
export const SCHED_UNKNOWN_REASONS = ["owner-closed", "crash", "reload", "start-timeout", "no-outcome"] as const;
export const SCHED_DROPPED_REASONS = [
  "coalesced",
  "owner-closed",
  "capability",
  "capability-unknown",
  "start-timeout",
] as const;
export const SCHED_REPORT_SKIPPED_REASONS = ["report-skipped(index-cap)", "report-skipped(cap)"] as const;

export interface RunRecord {
  /** auto `${taskId}@${T}`; manual `${taskId}@m-${hash8(reqId)}`. */
  runKey: string;
  taskId: string;
  kind: ScheduleRunKind;
  form: ScheduleForm;
  /** auto: T; manual: request time (display only, never a watermark input). */
  scheduledAt: number;
  defHash: string;
  state: ScheduleRunState;
  reason?: string;
  holder: Holder;
  runId?: string;
  startedAt: number;
  endedAt?: number;
  reportFile?: string;
  note: NoteState;
  /** details.noteId of the result message (globally unique random id). */
  noteId?: string;
  noteHolder?: Holder;
  /** Session-file size stat'ed before sending (proof reads start here). */
  noteFileOffset?: number;
  /** An outcome that arrived after the terminal state — audit only. */
  lateOutcome?: string;
}

/** Pending-delivery report index entry (§4.2.1), independent of `runs` eviction. */
export interface PendingReport {
  /** = reportIdOf(sessionId, runKey). */
  reportId: string;
  runKey: string;
  taskId: string;
  form: ScheduleForm;
  endedAt: number;
  /** endedAt + SCHED_REPORT_MAX_AGE_MS (N1). */
  expiresAt: number;
  /** Relative report path (short name for new runs, legacy 64-hex names remain readable). */
  reportFile: string;
  /** Terminal summary for the card title. */
  status: string;
}

export interface ReportStats {
  droppedIndexCap: number;
  lastDroppedAt?: number;
}

export interface ManualReq {
  runKey?: string;
  /** Recorded refusal (e.g. `E_OVERLAP`) so a replayed reqId answers identically. */
  refused?: string;
  at: number;
}

export interface DigestState {
  shownMissedTotal: Record<TaskId, number>;
  shownRunsThrough: number;
  inflight?: Holder & { id: string; at: number; fileOffset?: number };
}

export interface ScheduleStateFile {
  v: 1;
  /** Must equal the directory's sid, otherwise the file is degraded. */
  sessionId: string;
  /** +1 on every write. */
  rev: number;
  /** ≤ SCHED_MAX_TASKS_PER_SESSION. */
  tasks: ScheduleTask[];
  occ: Record<TaskId, OccState>;
  manualTotal: Record<TaskId, number>;
  runs: RunRecord[];
  /** ≤ SCHED_PENDING_REPORTS_MAX. */
  pendingReports: PendingReport[];
  reportStats: ReportStats;
  /** ≤ SCHED_MANUAL_REQS_MAX, TTL 24h. */
  manualReqs: Record<ReqId, ManualReq>;
  digest: DigestState;
}

export const SCHED_STATE_VERSION = 1;

/** A fresh, empty ledger for `sessionId` (rev 0 — the first write makes it 1). */
export function emptyStateFile(sessionId: string): ScheduleStateFile {
  return {
    v: SCHED_STATE_VERSION,
    sessionId,
    rev: 0,
    tasks: [],
    occ: {},
    manualTotal: {},
    runs: [],
    pendingReports: [],
    reportStats: { droppedIndexCap: 0 },
    manualReqs: {},
    digest: { shownMissedTotal: {}, shownRunsThrough: 0 },
  };
}

// ----------------------------------------------------------------- definition hash (§4.1, S2)

/** Fields that make up the execution definition, in no particular order (canonicalJson sorts). */
export const SCHED_EXECUTION_FIELDS = ["form", "when", "prompt", "feishu", "bg", "ownerCwd"] as const;
/** Fields `update` may NEVER write, from any source (§4.3). */
export const SCHED_UPDATE_FORBIDDEN_FIELDS = [
  "id",
  "approval",
  "createdBy",
  "createdVia",
  "createdAt",
  "ownerCwd",
] as const;

export type ScheduleExecutionDefinition = Pick<ScheduleTask, "form" | "when" | "prompt" | "feishu" | "bg" | "ownerCwd">;

/** Projects a task onto its execution definition (absent `bg` stays absent). */
export function executionDefinition(task: ScheduleTask): ScheduleExecutionDefinition {
  return {
    form: task.form,
    when: task.when,
    prompt: task.prompt,
    feishu: task.feishu,
    ...(task.bg === undefined ? {} : { bg: task.bg }),
    ownerCwd: task.ownerCwd,
  };
}

/** Canonical JSON per the module header's rule 2. Throws TypeError on non-canonicalizable input. */
export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}

function encode(value: unknown, at: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${at}`);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${at}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => (v === undefined ? "null" : encode(v, `${at}[${i}]`))).join(",")}]`;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`canonicalJson: non-plain object at ${at}`);
  const rec = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(rec).sort()) {
    const v = rec[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${encode(v, `${at}.${key}`)}`);
  }
  return `{${parts.join(",")}}`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256(canonicalJson(executionDefinition(task))) — 64 lowercase hex. */
export function defHash(task: ScheduleTask): string {
  return sha256Hex(canonicalJson(executionDefinition(task)));
}

/** Approved ⇔ an approval exists AND binds the current definition. */
export function isApproved(task: ScheduleTask): boolean {
  return task.approval !== undefined && task.approval.hash === defHash(task);
}

/** UI 「待确认」 — derived, never stored (§4.3). Independent of `enabled`. */
export function isPendingApproval(task: ScheduleTask): boolean {
  return !isApproved(task);
}

/** Executable ⇔ `enabled ∧ approval.hash === defHash` — checked under the lock by every entry. */
export function isExecutable(task: ScheduleTask): boolean {
  return task.enabled && isApproved(task);
}

// ----------------------------------------------------------------- keys (§4.2/§4.5b/§7.1)

/** First 8 hex of sha256(reqId) — manual runKey suffix. */
export function hash8(reqId: string): string {
  return sha256Hex(reqId).slice(0, 8);
}

export function autoRunKey(taskId: string, t: number): string {
  if (!SCHED_TASK_ID_RE.test(taskId)) throw new TypeError(`autoRunKey: bad task id ${JSON.stringify(taskId)}`);
  if (!Number.isSafeInteger(t) || t < 0) throw new TypeError(`autoRunKey: bad occurrence ${String(t)}`);
  return `${taskId}@${t}`;
}

export function manualRunKey(taskId: string, reqId: string): string {
  if (!SCHED_TASK_ID_RE.test(taskId)) throw new TypeError(`manualRunKey: bad task id ${JSON.stringify(taskId)}`);
  return `${taskId}@m-${hash8(reqId)}`;
}

export type ParsedRunKey = { taskId: string; kind: "auto"; t: number } | { taskId: string; kind: "manual"; h8: string };

export function parseRunKey(runKey: string): ParsedRunKey | undefined {
  if (!SCHED_RUN_KEY_RE.test(runKey)) return undefined;
  const at = runKey.indexOf("@");
  const taskId = runKey.slice(0, at);
  const rest = runKey.slice(at + 1);
  if (rest.startsWith("m-")) return { taskId, kind: "manual", h8: rest.slice(2) };
  const t = Number(rest);
  return Number.isSafeInteger(t) ? { taskId, kind: "auto", t } : undefined;
}

/** reportId = sha256(sid + "\0" + runKey) (§4.2.1/§7.1). */
export function reportIdOf(sessionId: string, runKey: string): string {
  return sha256Hex(`${sessionId}\0${runKey}`);
}

/** Base report path from the occurrence/trigger time, in task tz (absent ⇒ system local time).
 * The writer allocates a collision suffix UNDER the session lock; reportId stays independent. */
export function reportFileOf(taskId: string, scheduledAt: number, tz?: string): string {
  if (!SCHED_TASK_ID_RE.test(taskId)) throw new TypeError("invalid report task id");
  const parts = new Intl.DateTimeFormat("en-CA", {
    ...(tz === undefined ? {} : { timeZone: tz }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(scheduledAt);
  const get = (type: string): string => parts.find((p) => p.type === type)!.value;
  return `${SCHED_REPORTS_DIR}/${taskId}-${get("year")}${get("month")}${get("day")}-${get("hour")}${get("minute")}.md`;
}

export function isHash(value: unknown): value is string {
  return typeof value === "string" && SCHED_HASH_RE.test(value);
}

const NON_TERMINAL: ReadonlySet<string> = new Set(SCHEDULE_NON_TERMINAL_RUN_STATES);

export function isTerminalRunState(state: ScheduleRunState): boolean {
  return !NON_TERMINAL.has(state);
}
