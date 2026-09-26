import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { formatSize, truncateTail, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostRunView } from "../bash/child-registry.js";
import type { Millis } from "../core/types.js";
import {
  EXTEND_PERSIST_TIMEOUT_MS,
  type BashJobManager,
  type ExtendJobOutcome,
  type JobOutputRead,
} from "../bash/manager.js";
import { describeJobStatus, isTerminalJobStatus, previewCommand, type JobId, type JobRecord } from "../bash/types.js";
import { formatDuration } from "../ui/fleet-panel.js";
import { MARGIN_RETURN_MS, type BashDeadlineSurface } from "./bash-tool.js";
import {
  createPollGuard,
  createTimeoutStreak,
  type PollGuardOptions,
  type TimeoutStreakOptions,
} from "./poll-guard.js";

/**
 * "bash_job" — the management surface for bash commands that were moved to
 * the background (docs/dev/bash-auto-background/plan-fable.md section 4).
 *
 * One tool with an `action` discriminator rather than four tools (decision
 * D5): all four actions are small CRUD operations on the same entity and
 * share the `job_id` parameter, and this plugin already contributes five
 * tools to the table.
 *
 * **The log is a plain file.** There is deliberately no `output` action: the
 * model reads `record.logPath` with the `read` tool or with tail/grep/awk,
 * which is strictly more capable than any parameter set this tool could
 * offer. `status` therefore returns a state summary *plus* a bounded log tail
 * (enough to answer "what is it doing / how did it end?"), and points at the
 * file for anything larger or more targeted.
 *
 * Zero-hang rules inherited from the rest of the plugin:
 * - `wait` is bounded (default 30s, hard cap 120s) and **returns** the current
 *   status on timeout instead of throwing;
 * - `kill` is idempotent — an already finished job is reported, not an error —
 *   and carries the pid-reuse / process-group safety checks (I-c), which is
 *   why it stays a tool rather than becoming "just run kill in bash";
 * - reads never consume a job: `status` never advances a cursor, so it is a
 *   side-effect-free view — but polling it in a tight loop trips the poll
 *   guard (a warning is prepended telling the model to stop and await the
 *   completion notification).
 *
 * Only genuine caller errors throw: an unresolvable `job_id`, a missing
 * `job_id`, a kill that had to be refused for safety, or no active session.
 */

/** Default `wait` budget when the model does not ask for one. */
export const DEFAULT_WAIT_MS = 30_000;
/** Hard cap on `wait`, so a single call can never become a new hang point. */
export const MAX_WAIT_MS = 120_000;
/** Bytes of log tail `status` may read (context-frugal on purpose). */
export const STATUS_TAIL_BYTES = 2048;
/** Lines of log tail `status` shows out of those bytes. */
export const STATUS_TAIL_LINES = 20;
/** §2.6: `reason` cap for `extend`. */
export const EXTEND_REASON_MAX_CHARS = 200;
/** §2.6: the `extend_s` shown in the grace line as a concrete suggestion. */
const GRACE_LINE_EXTEND_S = 600;

const ACTION_DESCRIPTION =
  "status: state summary plus the tail of the job's log; " +
  "wait: block (bounded) until the job exits — a completion notification is pushed automatically when the " +
  "job finishes, and while wait blocks the user cannot send new input, so prefer status (or simply " +
  "continuing other work) unless there is nothing else to do; repeated timing-out waits escalate " +
  "guidance (raise wait_ms, or await the notification); " +
  "kill: terminate the process tree; list: all known jobs.";

const JOB_ID_DESCRIPTION =
  "Job id returned by a bash call that was moved to the background; a unique prefix is accepted. " +
  "Required for every action except list.";

const WAIT_MS_DESCRIPTION =
  "wait only: max milliseconds to block (default 30000, capped at 120000). " +
  "Returns the current status on timeout instead of failing.";

export const BashJobToolParams = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("wait"), Type.Literal("kill"), Type.Literal("list")], {
    description: ACTION_DESCRIPTION,
  }),
  job_id: Type.Optional(Type.String({ description: JOB_ID_DESCRIPTION })),
  wait_ms: Type.Optional(Type.Number({ description: WAIT_MS_DESCRIPTION })),
});
export type BashJobToolParams = Static<typeof BashJobToolParams>;

/**
 * §2.6/§5.2: the schema variant registered while the deadline/extend feature
 * is enabled — identical to `BashJobToolParams` except that the action union
 * gains `extend` plus the `extend_s` / `reason` parameters (T18: nothing else
 * differs). The disabled variant stays byte-identical to the golden fixture.
 */
export const BashJobToolExtendParams = Type.Object({
  action: Type.Union(
    [Type.Literal("status"), Type.Literal("wait"), Type.Literal("kill"), Type.Literal("list"), Type.Literal("extend")],
    {
      description: ACTION_DESCRIPTION,
    },
  ),
  job_id: Type.Optional(Type.String({ description: JOB_ID_DESCRIPTION })),
  wait_ms: Type.Optional(Type.Number({ description: WAIT_MS_DESCRIPTION })),
  extend_s: Type.Optional(
    Type.Number({
      description:
        "extend only: seconds to push the job's timeout deadline back by (capped by the job's hard " +
        "lifetime ceiling). Only a backgrounded job started with an explicit timeout can be extended; " +
        "if its timeout has already fired, extend during the grace window before the job is killed.",
    }),
  ),
  reason: Type.Optional(
    Type.String({
      description: `extend only: short reason (max ${EXTEND_REASON_MAX_CHARS} chars) recorded with the extension for later audit.`,
    }),
  ),
});
export type BashJobToolExtendParams = Static<typeof BashJobToolExtendParams>;

export interface BashJobToolDeps {
  /** Late-bound so the tool can be registered once and survive session rebuilds. */
  manager: () => BashJobManager | undefined;
  /**
   * bash-timeout-grace §3.6 child-session mode: the host run view providing
   * `watchdogDueAt()`. Provided ⇒ this is a child session: `wait` durations and
   * every disk read are bounded by `D − MARGIN_RETURN_MS` so the call always
   * returns before the tool-phase deadline. Absent ⇒ main session: unbounded
   * (today's semantics).
   */
  host?: () => HostRunView | undefined;
  /**
   * §2.6/§5.2 deadline switch: present and enabled (`maxExtensions > 0`,
   * `maxTimeoutFactor > 1`) ⇒ the schema carries `extend` / `extend_s` /
   * `reason`. Absent or disabled ⇒ the surface is byte-identical to today's
   * (golden fixture).
   */
  deadline?: () => BashDeadlineSurface | undefined;
  /** Injectable clock for deterministic durations in tests. */
  now?: () => Millis;
  /**
   * Anti-polling-loop guard for `status` (the action a stuck model loops on).
   * `wait` is excluded from the frequency guard: each call blocks for seconds
   * by design, so it cannot spin at "high frequency in a short window" — a
   * wait loop is caught by the consecutive-timeout streak below instead.
   * `list`/`kill` are not polling surfaces.
   */
  pollGuard?: PollGuardOptions;
  /** Consecutive-timeout streak for `wait` calls that keep timing out. */
  timeoutStreak?: TimeoutStreakOptions;
}

// ── formatting helpers (model-facing text) ─────────────────────────────────

function jobLabel(record: JobRecord): string {
  return `Bash job ${record.jobId} ($ ${previewCommand(record.command, 60)})`;
}

export { describeJobStatus };

function elapsedMs(record: JobRecord, now: Millis): Millis {
  const start = record.spawnedAt ?? record.createdAt;
  const end = record.endedAt ?? now;
  return Math.max(0, end - start);
}

/** One-sentence summary shared by status / wait / kill. */
export function formatJobSummary(record: JobRecord, now: Millis): string {
  const duration = formatDuration(elapsedMs(record, now));
  const parts: string[] = [];
  if (record.pid !== undefined && !isTerminalJobStatus(record.status)) parts.push(`pid ${record.pid}`);
  parts.push(`log ${formatSize(record.logBytes)}`);
  if (record.outputTruncated) parts.push("log size cap reached");
  const tail = ` (${parts.join(", ")})`;
  const phrase = describeJobStatus(record);
  return isTerminalJobStatus(record.status)
    ? `${jobLabel(record)}: ${phrase} after ${duration}${tail}.`
    : `${jobLabel(record)}: ${phrase} for ${duration}${tail}.`;
}

/**
 * The closing status line for a finished job. The inner bash tool's own text
 * ("Command exited with code 1", "Command timed out after 5 seconds", ...) is
 * authoritative when present; otherwise it is synthesized from the record.
 */
export function finalStatusLine(record: JobRecord): string {
  const fromInner = lastCommandLine(record.finalText);
  if (fromInner) return fromInner;
  switch (record.status) {
    case "completed":
      return `Command exited with code ${record.exitCode ?? 0}`;
    case "failed":
      return record.exitCode === null
        ? "Command failed before reporting an exit code"
        : `Command exited with code ${record.exitCode}`;
    case "timed_out":
      return "Command timed out and its process tree was killed";
    case "killed":
      return "Command was killed";
    case "exited_unknown":
      return "Command's process is gone; its exit code could not be recovered";
    case "orphaned":
      return "Job was left behind by an earlier pi process; its process could not be verified";
    default:
      return `Command is ${describeJobStatus(record)}`;
  }
}

function lastCommandLine(finalText: string | undefined): string | undefined {
  if (!finalText) return undefined;
  const lines = finalText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  return last !== undefined && last.startsWith("Command ") ? last : undefined;
}

function jobDetails(record: JobRecord, now: Millis): Record<string, unknown> {
  return {
    jobId: record.jobId,
    status: record.status,
    exitCode: record.exitCode,
    backgrounded: record.backgroundedAt !== undefined,
    terminal: isTerminalJobStatus(record.status),
    command: previewCommand(record.command),
    logPath: record.logPath,
    logBytes: record.logBytes,
    logTruncated: record.outputTruncated,
    durationMs: elapsedMs(record, now),
    ...(record.pid !== undefined ? { pid: record.pid } : {}),
    ...(record.spawnedAt !== undefined ? { startedAt: record.spawnedAt } : {}),
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
  };
}

function listLine(record: JobRecord, now: Millis): string {
  const age = formatDuration(Math.max(0, now - record.createdAt));
  return `${record.jobId} · ${describeJobStatus(record)} · $ ${previewCommand(record.command, 60)} · ${age} ago`;
}

function text(value: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text" as const, text: value }] };
}

// ── status assembly (summary + bounded log tail) ───────────────────────────

/** The model is told, everywhere, that the log is an ordinary file. */
export function formatLogFileHint(logPath: string): string {
  return (
    `Full log: ${logPath} — a plain file: read it directly with the read tool, or with tail/grep/awk. ` +
    `Prefer grep/tail over reading a large log whole.`
  );
}

function tailOffset(size: number): number {
  return Math.max(0, size - STATUS_TAIL_BYTES);
}

function lastLines(content: string, max: number): string {
  const trimmed = content.replace(/\n+$/, "");
  if (trimmed.length === 0) return "";
  const lines = trimmed.split("\n");
  return lines.slice(Math.max(0, lines.length - max)).join("\n");
}

/**
 * Best-effort tail read for `status`. Never advances the persisted cursor —
 * `status` is a pollable, side-effect-free view — and never throws: a missing
 * or unreadable log costs the tail, not the status.
 *
 * Two passes, like the completion notice: a record's `logBytes` can lag behind
 * the file (adopted jobs, throttled counters), and the first read reports the
 * real size.
 */
async function readStatusTail(manager: BashJobManager, record: JobRecord): Promise<JobOutputRead | undefined> {
  const options = { advanceCursor: false as const, maxBytes: STATUS_TAIL_BYTES };
  try {
    let read = await manager.readOutput(record.jobId, { ...options, offset: tailOffset(record.logBytes) });
    if (read.logBytes > record.logBytes) {
      read = await manager.readOutput(record.jobId, { ...options, offset: tailOffset(read.logBytes) });
    }
    return read;
  } catch {
    return undefined;
  }
}

function formatStatus(record: JobRecord, read: JobOutputRead | undefined, at: Millis): string {
  const lines: string[] = [formatJobSummary(record, at)];
  const grace = formatGraceLine(record, at);
  if (grace !== undefined) lines.push(grace);
  const raw = read ? lastLines(read.content, STATUS_TAIL_LINES) : "";
  if (raw.length > 0) {
    // truncateTail is pi's own context guard: even 20 lines can be huge.
    lines.push(`--- log tail (last ${STATUS_TAIL_LINES} lines, ${formatSize(read!.logBytes)} total) ---`);
    lines.push(truncateTail(raw).content, "---");
  } else {
    lines.push(read && read.logBytes > 0 ? "(no readable log tail)" : "(the log is empty so far)");
  }
  if (record.outputTruncated) lines.push("(the job's log hit its size cap; some output was dropped)");
  lines.push(formatLogFileHint(record.logPath));
  return lines.join("\n");
}

/** §2.6/§3.6 — the deadline budget shared by `status`/`wait` in child mode. */
interface ReturnBudget {
  /** Absolute ms timestamp the call must have returned by (D − MARGIN_RETURN). */
  readonly dueAt: Millis;
  remaining(at: Millis): number;
}

function makeBudget(dueAt: Millis): ReturnBudget {
  return { dueAt, remaining: (at: Millis) => Math.max(0, dueAt - at) };
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  // A ref'd timer wedges `pi -p` (AGENTS.md).
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

/** §3.6: race a disk read against the remaining budget; `false` = budget out. */
async function raceBudget<T>(read: Promise<T>, budgetMs: number): Promise<{ ok: true; value: T } | { ok: false }> {
  if (budgetMs <= 0) return { ok: false };
  return new Promise((resolve) => {
    const timer = unrefTimer(setTimeout(() => resolve({ ok: false }), budgetMs));
    read.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      () => {
        clearTimeout(timer);
        resolve({ ok: false });
      },
    );
  });
}

interface BoundedRecord {
  readonly record: JobRecord;
  /** True when the disk read lost the deadline race (memory state used). */
  readonly degraded: boolean;
}

async function loadRecord(manager: BashJobManager, jobId: string): Promise<JobRecord> {
  const record = (await manager.load(jobId)) ?? manager.get(jobId);
  if (!record) throw new Error(`bash job not found: ${jobId}`);
  return record;
}

/**
 * `loadRecord` under a child-session budget (§3.6): the disk read races the
 * budget; on loss (or a store hang) the in-memory entry is the answer. A job
 * known to neither is the same "not found" as today.
 */
async function loadRecordBounded(
  manager: BashJobManager,
  jobId: JobId,
  budget: ReturnBudget | undefined,
  now: () => Millis,
): Promise<BoundedRecord> {
  if (budget === undefined) return { record: await loadRecord(manager, jobId), degraded: false };
  const raced = await raceBudget(manager.load(jobId), budget.remaining(now()));
  if (raced.ok) {
    const record = raced.value ?? manager.get(jobId);
    if (!record) throw new Error(`bash job not found: ${jobId}`);
    return { record, degraded: false };
  }
  const memory = manager.get(jobId);
  if (!memory) throw new Error(`bash job not found: ${jobId}`);
  return { record: memory, degraded: true };
}

/** §2.6: the in-grace reminder line for `status` / `wait`. */
export function formatGraceLine(record: JobRecord, at: Millis): string | undefined {
  const deadline = record.deadline;
  if (deadline === undefined || deadline.graceUntil === undefined) return undefined;
  if (record.status !== "running") return undefined;
  const leftMs = deadline.graceUntil - at;
  if (leftMs <= 0) return undefined;
  return (
    `⏳ timeout reached — killed in ${Math.ceil(leftMs / 1000)}s unless extended: ` +
    `bash_job(action: "extend", job_id: "${record.jobId}", extend_s: ${GRACE_LINE_EXTEND_S})`
  );
}

// ── tool ───────────────────────────────────────────────────────────────────

export function createBashJobTool(deps: BashJobToolDeps): ToolDefinition<typeof BashJobToolExtendParams> {
  const now = deps.now ?? (() => Date.now());
  // §5.2: schema trimming — extend is only in the surface while the deadline
  // feature is enabled (maxExtensions > 0 and real headroom, D-6).
  const extendEnabled =
    deps.deadline !== undefined &&
    (() => {
      try {
        const surface = deps.deadline?.();
        return surface !== undefined && surface.maxExtensions > 0 && surface.maxTimeoutFactor > 1;
      } catch {
        return false;
      }
    })();
  const waitStreak = createTimeoutStreak(deps.timeoutStreak);
  const statusPollGuard = createPollGuard({
    windowMs: deps.pollGuard?.windowMs,
    maxCalls: deps.pollGuard?.maxCalls,
    // The guard's clock defaults to the tool's own (test-injectable) clock.
    now: deps.pollGuard?.now ?? now,
    message:
      deps.pollGuard?.message ??
      ((key, count, window) =>
        `⚠️ Polling too frequently: bash_job status has been called ${count} times for job "${key}" ` +
        `within ${formatDuration(window)}. This looks like a polling loop — STOP polling. ` +
        `End your turn and wait for the job's completion notification to arrive; to inspect output use ` +
        `tail/grep on the log file directly; if you must block, make ONE final call with action: "wait" ` +
        `instead of repeated status polls.`),
  });

  function requireManager(): BashJobManager {
    const manager = deps.manager();
    if (!manager) throw new Error("pi-subagent: no active session yet, bash jobs are unavailable");
    return manager;
  }

  function requireJobId(params: BashJobToolExtendParams): string {
    const handle = params.job_id?.trim();
    if (!handle) throw new Error(`bash_job(action: "${params.action}") requires job_id`);
    return handle;
  }

  async function loadRecord(manager: BashJobManager, jobId: string): Promise<JobRecord> {
    const record = (await manager.load(jobId)) ?? manager.get(jobId);
    if (!record) throw new Error(`bash job not found: ${jobId}`);
    return record;
  }

  return {
    name: "bash_job",
    label: "Bash Job",
    description:
      "Manage bash commands that were moved to the background (a bash call that runs past the threshold returns a " +
      "job_id instead of blocking; the process keeps running with its output captured to a log file). " +
      "Actions: status (state summary plus the tail of the log), wait (block up to wait_ms, returns the current " +
      "status on timeout; a completion notification arrives on its own when the job finishes, and while " +
      "wait blocks the user cannot send new input, so prefer status or continuing other work unless there is " +
      "nothing else to do; repeated timing-out waits escalate the guidance toward raising wait_ms or " +
      "awaiting the notification), kill (terminate the process tree; safe to repeat), list (this " +
      "session's jobs). " +
      "The log is a plain file: for the full or a targeted view, read its path directly with the read tool or with " +
      "tail/grep/awk instead of calling this tool (grep a large log rather than reading it whole). " +
      "list and status only expose jobs started by this session. Nothing here consumes the job, so status is safe to poll " +
      "— but rapid repeated polling of the same job returns a warning; await the completion notification instead.",
    promptSnippet:
      'bash_job(action: "status"|"wait"|"kill"|"list", job_id?, wait_ms?) - inspect, wait for, or stop a ' +
      "backgrounded bash command (job_id comes from the bash call that was moved to the background; a unique prefix " +
      "works); its log is a plain file you can also read/tail/grep directly",
    // §5.2: the extend-enabled variant only while the feature is on; the
    // disabled surface is byte-identical to the golden fixture.
    parameters: extendEnabled
      ? BashJobToolExtendParams
      : (BashJobToolParams as unknown as typeof BashJobToolExtendParams),
    renderCall(args, theme, context) {
      const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const action = args?.action ?? "…";
      const target = args?.action === "list" ? "" : ` ${args?.job_id ?? "…"}`;
      component.setText(theme.fg("toolTitle", theme.bold(`bash_job ${action}${target}`)));
      return component;
    },

    async execute(_toolCallId, params, signal) {
      const manager = requireManager();

      // §3.6 child-session mode: every bounded action and every disk read must
      // be done by D − MARGIN_RETURN. No host view (or a view that answers
      // `undefined`) ⇒ unbounded, today's semantics.
      let budget: ReturnBudget | undefined;
      if (deps.host !== undefined) {
        let due: Millis | undefined;
        try {
          const value = deps.host()?.watchdogDueAt();
          due = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
        } catch {
          due = undefined;
        }
        if (due !== undefined) budget = makeBudget(due - MARGIN_RETURN_MS);
      }

      if (params.action === "list") {
        const records = manager.list();
        const at = now();
        if (records.length === 0) return { ...text("no bash jobs"), details: { count: 0, jobs: [] } };
        const lines = records.map((record) => listLine(record, at));
        return {
          ...text(`${records.length} bash job${records.length === 1 ? "" : "s"}:\n${lines.join("\n")}`),
          details: { count: records.length, jobs: records.map((record) => jobDetails(record, at)) },
        };
      }

      // Resolution (exact id or unique prefix) throws a candidate-listing
      // error the model can self-correct from.
      const jobId = manager.resolve(requireJobId(params));

      if (params.action === "status") {
        const pollWarning = statusPollGuard.record(jobId);
        const loaded = await loadRecordBounded(manager, jobId, budget, now);
        const record = loaded.record;
        const at = now();
        // The tail read is side-effect free (advanceCursor: false), so status
        // stays a safe poll: it never hides output from a later read. In child
        // mode it also races the return budget (§3.6): a store/log read that
        // cannot finish in time degrades to the memory state, and the tail
        // says so instead of hanging the call.
        let read: JobOutputRead | undefined;
        let tailBudgetExhausted = false;
        if (budget === undefined) {
          read = await readStatusTail(manager, record);
        } else {
          const raced = await raceBudget(readStatusTail(manager, record), budget.remaining(at));
          if (raced.ok) read = raced.value;
          else tailBudgetExhausted = true;
        }
        const statusText =
          tailBudgetExhausted && read === undefined
            ? `${formatStatus(record, undefined, at)}\nlog tail unavailable (time budget)`
            : formatStatus(record, read, at);
        return {
          ...text(pollWarning ? `${pollWarning}\n\n${statusText}` : statusText),
          details: {
            ...jobDetails(record, at),
            tailBytes: read ? read.nextOffset - read.startOffset : 0,
            tailFromOffset: read?.startOffset ?? 0,
            ...(loaded.degraded ? { degraded: true } : {}),
            ...(tailBudgetExhausted && read === undefined ? { tailBudgetExhausted: true } : {}),
          },
        };
      }

      if (params.action === "wait") {
        const requested = Number.isFinite(params.wait_ms ?? NaN) ? Math.trunc(params.wait_ms as number) : undefined;
        // §3.6: min(wait_ms ?? 30s, 120s, D − now − MARGIN_RETURN) — a child
        // session's wait never outlives the tool-phase deadline.
        const capped = Math.min(MAX_WAIT_MS, Math.max(0, requested ?? DEFAULT_WAIT_MS));
        const budgetLeft = budget?.remaining(now()) ?? Number.POSITIVE_INFINITY;
        const waitMs = Math.min(capped, Math.max(0, budgetLeft));
        const before = (await loadRecordBounded(manager, jobId, budget, now)).record;
        // The abort signal matters here: without it the wait outlasts Esc and
        // session teardown (/exit) until wait_ms fires, wedging the turn.
        const waited = isTerminalJobStatus(before.status)
          ? before
          : ((await manager.waitExit(jobId, waitMs, { signal })) ??
            (await loadRecordBounded(manager, jobId, budget, now)).record);
        const record = waited;
        if (signal?.aborted) throw new Error("wait was aborted");
        const at = now();
        const grace = formatGraceLine(record, at);
        const finished = isTerminalJobStatus(record.status);
        let suffix: string;
        if (finished) {
          waitStreak.reset(jobId);
          suffix = `\n${finalStatusLine(record)}\n${formatLogFileHint(record.logPath)}`;
        } else if (grace !== undefined) {
          // §2.6: an in-grace wait result leads with the extend-or-expire line.
          waitStreak.reset(jobId);
          suffix =
            `\n${grace} Doing nothing lets the job be killed as timed_out when the grace window ends — ` +
            `that is a valid choice if you no longer need the result.`;
        } else {
          // A timing-out wait is not an error, but the streak escalates the
          // guidance when the model keeps re-waiting on the same job: raise
          // wait_ms (capped) or stop blocking and await the notification.
          const streak = waitStreak.timeout(jobId, waitMs);
          const escalation = streak.escalate
            ? ` That is ${streak.streak} consecutive wait timeouts on this job ` +
              `(~${formatDuration(streak.totalWaitedMs)} spent blocked) — re-waiting does not make it finish faster.`
            : "";
          suffix =
            `\nStill running after waiting ${formatDuration(waitMs)}; the job was not stopped.${escalation} ` +
            `Either retry with a larger wait_ms (cap ${formatDuration(MAX_WAIT_MS)}) if blocking is genuinely ` +
            "necessary, or — preferred — end your turn (or keep working) and let the job's completion " +
            "notification arrive; to inspect output, tail/grep the log file.";
        }
        return {
          ...text(`${formatJobSummary(record, at)}${suffix}`),
          details: { ...jobDetails(record, at), waitedMs: waitMs, finished },
        };
      }

      if (params.action === "extend") {
        // §2.6/§5.2: `extend` exists only on the enabled surface. The schema is
        // trimmed while the deadline feature is off, so reaching here means a
        // stale surface — refuse by the same settings switch that trimmed it,
        // never by probing the manager's shape at runtime.
        if (!extendEnabled) {
          throw new Error(
            `bash_job(action: "extend") is not available in this session ` +
              "(the bash job deadline feature is disabled)",
          );
        }
        const extendSeconds = params.extend_s;
        if (extendSeconds === undefined || !Number.isFinite(extendSeconds) || extendSeconds <= 0) {
          throw new Error('bash_job(action: "extend") requires extend_s: a positive number of seconds');
        }
        const reason = params.reason?.trim();
        if (reason !== undefined && reason.length > EXTEND_REASON_MAX_CHARS) {
          throw new Error(
            `bash_job(action: "extend") reason is too long (${reason.length} chars; ` +
              `max ${EXTEND_REASON_MAX_CHARS})`,
          );
        }
        const at = now();
        const before = manager.get(jobId);
        // §2.6/R7: the manager adjudicates the extension synchronously in
        // memory (timers/waiters already reflect it) and waits at most
        // EXTEND_PERSIST_TIMEOUT_MS (2s) for the write-behind record itself;
        // `persistPending: true` means the write is still queued, which is
        // noted in the output instead of blocking the model any further.
        let outcome: ExtendJobOutcome;
        try {
          outcome = await manager.extend(jobId, Math.round(extendSeconds * 1000), reason || undefined);
        } catch (error) {
          // R8: a disposed manager throws `stale bash job manager` — surface it.
          throw error instanceof Error ? error : new Error(String(error));
        }
        if (!outcome.ok) throw new Error(extendRefusal(jobId, outcome.reason, before));
        const record = outcome.record;
        const deadline = record.deadline;
        if (deadline === undefined) {
          // Unreachable for a real manager (ok implies an extended deadline).
          throw new Error(`bash job ${jobId} was extended but carries no deadline`);
        }
        const persistPending = outcome.persistPending;
        const previousDueAt = before?.deadline?.dueAt;
        const grantedMs =
          previousDueAt !== undefined ? Math.max(0, deadline.dueAt - previousDueAt) : deadline.grantedMs;
        const extensionsLeft = Math.max(0, deadline.policy.maxExtensions - deadline.extensions);
        const lines = [
          `Bash job ${jobId} ($ ${previewCommand(record.command, 60)}) extended by ${formatDuration(grantedMs)} — ` +
            `its timeout now fires in ${formatDuration(Math.max(0, deadline.dueAt - at))} ` +
            `(${extensionsLeft} of ${deadline.policy.maxExtensions} extensions left, ` +
            `hard lifetime ceiling in ${formatDuration(Math.max(0, deadline.hardAt - deadline.dueAt))}).`,
        ];
        if (persistPending) {
          lines.push(
            "[persist pending: the extension is already in effect; the job record on disk has not confirmed it " +
              `within ${formatDuration(EXTEND_PERSIST_TIMEOUT_MS)}]`,
          );
        }
        lines.push(formatLogFileHint(record.logPath));
        return {
          ...text(lines.join("\n")),
          details: {
            ...jobDetails(record, at),
            extended: true,
            extendMs: Math.round(extendSeconds * 1000),
            grantedMs,
            extensionsLeft,
            dueAt: deadline.dueAt,
            hardAt: deadline.hardAt,
            ...(persistPending ? { persistPending: true } : {}),
          },
        };
      }

      // kill
      const existing = await loadRecord(manager, jobId);
      if (existing.status === "orphaned") throw new Error(orphanRefusal(jobId));
      const result = await manager.kill(jobId);
      const at = now();
      const phrase = describeJobStatus(result.record);
      if (result.outcome === "refused") throw new Error(result.reason ?? orphanRefusal(jobId));
      if (result.alreadyTerminal && result.outcome !== "already-terminal") {
        return {
          ...text(
            `Bash job ${jobId} had already finished (${phrase}); ${result.reason ?? "surviving pipe holders were handled"}.\n` +
              formatLogFileHint(result.record.logPath),
          ),
          details: { ...jobDetails(result.record, at), alreadyTerminal: true, killed: true, outcome: result.outcome },
        };
      }
      if (result.alreadyTerminal) {
        return {
          ...text(
            `Bash job ${jobId} has already finished (${phrase}); nothing to kill.\n` +
              formatLogFileHint(result.record.logPath),
          ),
          details: { ...jobDetails(result.record, at), alreadyTerminal: true, killed: false },
        };
      }
      const how = result.outcome === "already-dead" ? "its process was already gone" : `signalled (${result.outcome})`;
      return {
        ...text(
          `Bash job ${jobId} ($ ${previewCommand(result.record.command, 60)}): ${how}.\n` +
            formatLogFileHint(result.record.logPath),
        ),
        details: { ...jobDetails(result.record, at), alreadyTerminal: false, killed: true, outcome: result.outcome },
      };
    },
  } satisfies ToolDefinition<typeof BashJobToolExtendParams>;
}

function orphanRefusal(jobId: string): string {
  return (
    `bash job ${jobId} was left behind by an earlier pi process and cannot be safely killed ` +
    "(its process identity could not be verified, so killing it might hit an unrelated process)"
  );
}

/** §2.6: every `extend` refusal, phrased so the model can self-correct. */
function extendRefusal(jobId: string, reason: string, before: JobRecord | undefined): string {
  const deadline = before?.deadline;
  switch (reason) {
    case "already_terminal":
      return `bash job ${jobId} has already finished — there is no timeout left to extend`;
    case "no_timeout":
      return `bash job ${jobId} was started without an explicit timeout, so it has no deadline to extend`;
    case "foreground":
      return (
        `bash job ${jobId} is still in the foreground — its timeout cannot be extended; wait for the call to ` +
        "finish or to be moved to the background first"
      );
    case "limit_reached":
      return (
        `bash job ${jobId} already used its full extension budget ` +
        `(${deadline?.extensions ?? "all"} of ${deadline?.policy.maxExtensions ?? "its"} extensions) — ` +
        "the next timeout fires for good"
      );
    case "no_headroom":
      return (
        `bash job ${jobId} has reached its hard lifetime ceiling ` +
        `(${deadline ? `${deadline.policy.maxTimeoutFactor}x its original timeout` : "timeout x factor"}) — ` +
        "it cannot be extended any further"
      );
    case "zero_gain":
      return (
        `bash job ${jobId} could not be extended: the requested amount would add no time ` +
        "(it is already capped by the job's hard lifetime ceiling)"
      );
    default:
      return `bash job ${jobId} could not be extended: ${reason}`;
  }
}
