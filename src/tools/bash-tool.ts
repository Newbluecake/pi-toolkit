import { Type, type Static } from "@sinclair/typebox";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  BashOperations,
  BashToolDetails,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Millis } from "../core/types.js";
import type { HostRunView } from "../bash/child-registry.js";
import type { BashJobManager, CreatedJob, ReservedJob } from "../bash/manager.js";
import type { JobDeadlinePolicy, JobId } from "../bash/types.js";
import { formatDuration } from "../ui/fleet-panel.js";

/**
 * bash auto-background §2 — the same-name override of pi's built-in `bash`
 * tool: a foreground call that outlives the configured threshold returns early
 * with a `job_id` while **the process keeps running** (§1 Z1/Z2).
 *
 * Compatibility doctrine (§2.1/§2.3): the short-command path is not an
 * imitation of the built-in tool, it *is* the built-in tool. Every call builds
 * a real `createBashToolDefinition(ctx.cwd, { operations })` and delegates to
 * its `execute`; output accumulation, truncation, the temp-file footer,
 * `(no output)`, `Command exited with code N`, `Command aborted`,
 * `Command timed out after Ns` and the 100 ms-throttled `onUpdate` stream are
 * all produced by pi's own code, and the resolve/reject is passed through
 * verbatim. The only thing this file owns is:
 *
 *  - `BashOperations.exec` — routed through `BashJobManager` so the process is
 *    a detached group leader with its output tee'd to a job log (the built-in
 *    accumulator still gets every byte, so the foreground result is unchanged);
 *  - `race(inner, threshold)` plus the relay/abort state gate copied from
 *    `agent-tool.ts:318-334`: after backgrounding, a caller abort must **not**
 *    reach the process (§2.4), and the inner promise is handed to the manager
 *    so its eventual settlement lands in `finalText` instead of becoming an
 *    unhandled rejection (§2.3).
 *
 * bash-timeout-grace §3.6 (P4): the race is now a **two-layer race with a
 * single synchronous latch**. The outer layer (`execute` below) races the
 * inner exec's whole promise (`settled` — it only settles when the command
 * ends) against the R timer and the caller's abort; R therefore spans the
 * entire call no matter which await the inner layer is parked on. The inner
 * layer (`execViaManager`) never learns about R: it reserves the job
 * synchronously (`manager.reserve`, E33), awaits `started` (never rejects,
 * R12-bounded), then awaits `job.exit`. Whichever of `settled` / R / abort
 * runs first sets the latch (`backgrounded` / `foregroundDone`) in its
 * synchronous callback prologue, so "R and `started`/`exit` arrive in the same
 * tick" has exactly one winner. The background branch never awaits
 * `markBackgrounded` — the manager's synchronous `markBackgroundedSync`
 * (write-behind persistence, R5/R10) hands the caller `job_id`/`logPath`
 * right away (`pid starting` until the spawn completes).
 *
 * Layering: no session/stack state is captured — the manager and the threshold
 * arrive as getters so `src/index.ts` (main session) / `src/bash/child.ts`
 * (child session, later package) can forward the current stack's instance
 * (the extension re-activates in-process on `/reload`).
 */

/**
 * §2.1/R7 — hand-written schema. pi does not export `bashSchema`, and deriving
 * from `inner.parameters` would cross two different typebox instances
 * (`@sinclair/typebox` here, pi's bundled `typebox` there). The `command` /
 * `timeout` descriptions are therefore duplicated verbatim and pinned against
 * the real thing by a drift test (`tests/tools/bash-tool.test.ts` T1).
 */
export const BashToolParams = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        "If true, the command is started in the background immediately and the call returns with a job_id; " +
        "the process keeps running (check on it with the bash_job tool). Use this ONLY for fire-and-forget " +
        "commands whose result you will never need, or as a one-shot timer (see the tool description). " +
        "For a long command whose result you DO need, omit this " +
        "and run it in the foreground — the call returns early on its own once it passes the auto-background " +
        "threshold, so explicitly backgrounding and then blocking on bash_job wait wastes an extra request.",
    }),
  ),
});
export type BashToolParams = Static<typeof BashToolParams>;

/** Details of a backgrounded call (§2.4/§8). Foreground details stay pi's `BashToolDetails`. */
export interface BashBackgroundDetails {
  jobId: JobId;
  background: true;
  /** Set only when the threshold (not `run_in_background`) triggered it. */
  autoBackgrounded?: true;
  /**
   * Absent while the call was handed back before the spawn completed (§3.6
   * child-session R return: the text says `pid starting` instead).
   */
  pid?: number;
  logPath: string;
}

export type BashOverrideDetails = BashToolDetails | BashBackgroundDetails | undefined;

// ── deadline surface settings (§5.2 switch) ────────────────────────────────

/**
 * The `bashJobs` deadline knobs the tool *surfaces* need (§2.6/§5.2). Absent
 * (`deps.deadline` undefined) or disabled (`maxExtensions <= 0`, or
 * `maxTimeoutFactor <= 1` = no headroom, D-6) ⇒ every surface is byte-identical
 * to today's, which is what the golden fixture pins.
 */
export type BashDeadlineSurface = JobDeadlinePolicy;

/**
 * §3.6 `MARGIN_RETURN`: the child-session return budget subtracted from the
 * host watchdog's due date. ≥ 2 watchdog ticks + 1s adjudication lag (E30);
 * 1s of it is the tick-judgment reserve, the rest is the B-LOOP boundary for
 * event-loop lag plus pi's post-tool hook chain (E26).
 */
export const MARGIN_RETURN_MS = 3_000;

export interface BashToolDeps {
  /** Current session's job manager; `undefined` ⇒ pure pass-through to pi. */
  manager: () => BashJobManager | undefined;
  /** Auto-background threshold in ms; `0`/negative ⇒ pure pass-through. */
  autoBackgroundMs: () => number;
  /**
   * §3.6 child-session mode: the host run view providing `watchdogDueAt()`.
   * Provided (even when it resolves to `undefined`) ⇒ this is a child session:
   * R = min(now + autoBackgroundMs, D − MARGIN_RETURN_MS), background slots may
   * be exceeded on auto-background (C2), and the R return does not wait for a
   * pid (`pid starting`). Absent ⇒ main session: today's semantics exactly.
   */
  host?: () => HostRunView | undefined;
  /**
   * §3.6 static fallback when no host view is attached to this child session
   * yet: the watchdog's tool-phase budget (settings `budget.toolS`, ms). Used
   * as `D = callStart + toolBudgetMs`; a warn is emitted once per tool
   * instance. Only consulted in child mode (`host` provided) and only when the
   * view itself is absent (a view that answers `undefined` means "no D ⇒ no
   * truncation").
   */
  toolBudgetMs?: () => number | undefined;
  /**
   * §2.6/§5.2 deadline switch for the description suffix. Absent or disabled ⇒
   * the description is byte-identical to today's (golden fixture).
   */
  deadline?: () => BashDeadlineSurface | undefined;
  /** Injectable clock (R/elapsed math); defaults to `Date.now`. */
  now?: () => Millis;
  /** Diagnostics sink (defaults to `console.warn`, like the rest of the plugin). */
  warn?: (message: string) => void;
}

/** pi's own cap, replicated so an invalid `timeout` fails before anything spawns. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

/**
 * Byte-identical to pi's private `resolveTimeoutMs` (`dist/core/tools/bash.js`)
 * — same messages, same order — so an invalid timeout throws exactly what the
 * built-in tool throws, before a job record is ever created.
 */
function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutMs;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  // A ref'd timer wedges `pi -p` (AGENTS.md).
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

/** §8 — deliberately isomorphic to the Agent tool's auto-background wording. */
export function formatAutoBackgroundText(jobId: JobId, elapsedMs: number, logPath: string): string {
  return (
    `Bash command is still running after ${formatDuration(elapsedMs)} and has been moved to the background ` +
    `(job_id: ${jobId}). The process was NOT killed — it keeps running with output captured to a log ` +
    `(${logPath}), and you will receive a completion notification when it finishes. Do not block or poll for it now. ` +
    `Later: bash_job(action: "status", job_id: "${jobId}") for a summary plus the log tail, or read that log path ` +
    `directly — it is a plain file, so the read tool and tail/grep/awk all work (grep a large log rather than ` +
    `reading it whole). Stop it with bash_job(action: "kill", job_id: "${jobId}").`
  );
}

/**
 * §3.6 — the R return fired before the spawn completed: no pid exists yet, so
 * the text says `pid starting` and the model is told how to watch it settle.
 */
export function formatAutoBackgroundTextStarting(jobId: JobId, elapsedMs: number, logPath: string): string {
  return (
    `Bash command is still running after ${formatDuration(elapsedMs)} and has been moved to the background ` +
    `(job_id: ${jobId}, pid starting). The process was NOT killed — it is starting up and keeps running with ` +
    `output captured to a log (${logPath}), and you will receive a completion notification when it finishes. ` +
    `Do not block or poll for it now. Later: bash_job(action: "status", job_id: "${jobId}") for a summary plus ` +
    `the log tail, or read that log path directly — it is a plain file, so the read tool and tail/grep/awk all ` +
    `work (grep a large log rather than reading it whole). Stop it with bash_job(action: "kill", job_id: "${jobId}").`
  );
}

/** §2.2 — the explicit `run_in_background: true` variant (no "still running after" prefix). */
export function formatExplicitBackgroundText(jobId: JobId, pid: number, logPath: string): string {
  return (
    `Bash command started in the background (job_id: ${jobId}, pid: ${pid}). The process was NOT killed — ` +
    `output is captured to a log (${logPath}), and you will receive a completion notification when it finishes. ` +
    `Do not block or poll for it now. Later: bash_job(action: "status", job_id: "${jobId}") for a summary plus the ` +
    `log tail, or read that log path directly — it is a plain file, so the read tool and tail/grep/awk all work ` +
    `(grep a large log rather than reading it whole). Stop it with bash_job(action: "kill", job_id: "${jobId}").`
  );
}

/** §3.6 — the explicit `run_in_background: true` variant when the pid is not assigned yet. */
export function formatExplicitBackgroundTextStarting(jobId: JobId, logPath: string): string {
  return (
    `Bash command started in the background (job_id: ${jobId}, pid starting). The process was NOT killed — ` +
    `it is starting up, with output captured to a log (${logPath}), and you will receive a completion ` +
    `notification when it finishes. Do not block or poll for it now. Later: bash_job(action: "status", ` +
    `job_id: "${jobId}") for a summary plus the log tail, or read that log path directly — it is a plain file, ` +
    `so the read tool and tail/grep/awk all work (grep a large log rather than reading it whole). Stop it with ` +
    `bash_job(action: "kill", job_id: "${jobId}").`
  );
}

/** §3.8 — the threshold fired but every background slot is taken: stay in the foreground. */
export function formatCapacityNote(maxBackgroundJobs: number): string {
  return (
    `[This command exceeded the auto-background threshold but all ${maxBackgroundJobs} background job slots ` +
    `were in use, so the call kept waiting in the foreground. Finish or kill an existing job with bash_job ` +
    `to free a slot.]`
  );
}

function capacityError(maxBackgroundJobs: number): Error {
  return new Error(
    `cannot start a background bash job: all ${maxBackgroundJobs} background job slots are in use ` +
      `(settings bashJobs.maxBackgroundJobs). Wait for a job to finish, or free a slot with ` +
      `bash_job(action: "kill", job_id: "…"), or re-run the command in the foreground ` +
      `(omit run_in_background).`,
  );
}

/** Threshold sentence appended to pi's own bash description (§2.1). */
export function formatDescriptionSuffix(autoBackgroundMs: number): string {
  return (
    ` If a command runs longer than ~${formatDuration(autoBackgroundMs)}, the call returns early on its own ` +
    `with a job_id — the process is NOT killed, it keeps running with its output captured to a log file, and ` +
    `you are notified when it finishes. So for a long-running command whose result you need, just run it in ` +
    `the foreground and let this threshold move it to the background — do NOT set run_in_background: true and ` +
    `then block on bash_job wait; that wastes an extra request for nothing. Reserve run_in_background: true ` +
    `for fire-and-forget commands whose result you will never need. Manage a backgrounded job with the ` +
    `bash_job tool (status / wait / kill / list); the log is a plain file, so you can also read it directly ` +
    `with the read tool or with tail/grep/awk.` +
    ` One-shot timer: to resume work at a known later time (a quota window reset, a rate-limit backoff, an ` +
    `external job due at a known time), start \`sleep <seconds> && echo "<what to do on wake-up>"\` with ` +
    `run_in_background: true — its completion notification wakes you and shows the echoed line, so state the ` +
    `follow-up action in it (the conversation may have been compacted during a long wait). Compute <seconds> yourself (portable; no ` +
    `\`date -d\`). Timers are for a single wait with a known deadline, never for polling: every wake-up costs ` +
    `a full model turn, so do not loop short sleeps, and prefer real completion notifications (subagents, ` +
    `background jobs) when one exists. If the wait becomes unnecessary, cancel it with ` +
    `bash_job(action: "kill", job_id: "…"). A pi restart or /reload may drop a sleeping timer, so do not ` +
    `rely on one across a restart.`
  );
}

/**
 * §2.6/§5.2 — the deadline sentence appended to the bash description when the
 * extend/grace feature is enabled. `""` when disabled
 * (`maxExtensions <= 0` or `maxTimeoutFactor <= 1`), so the off-baseline
 * description stays byte-identical to the golden fixture.
 */
export function formatDeadlineSuffix(surface: BashDeadlineSurface | undefined): string {
  if (surface === undefined) return "";
  if (surface.maxExtensions <= 0 || surface.maxTimeoutFactor <= 1) return "";
  const budget = `at most ${surface.maxExtensions} extension${
    surface.maxExtensions === 1 ? "" : "s"
  }, total lifetime capped at ${surface.maxTimeoutFactor}x the original timeout`;
  if (surface.graceMs > 0) {
    return (
      ` A backgrounded job whose explicit timeout has fired is not killed immediately: it first gets a ` +
      `${formatDuration(surface.graceMs)} grace window (you are notified) — give it more time with ` +
      `bash_job(action: "extend", job_id: "…", extend_s: 600) (${budget}), or do nothing and it is killed as ` +
      `timed_out when the grace ends.`
    );
  }
  return (
    ` A backgrounded job whose explicit timeout has fired is killed at once (no grace window), but you can ` +
    `push the deadline back before it fires with bash_job(action: "extend", job_id: "…", extend_s: 600) ` +
    `(${budget}).`
  );
}

interface InnerParams {
  command: string;
  timeout?: number;
}

/**
 * Per-call bookkeeping shared between the injected `exec` and the outer race.
 * `reservation` is set the moment `reserve()` returns (synchronously, E33) so
 * the outer race can hand the call back before any pid exists; `job` (the
 * pid-bearing `CreatedJob`) follows once `started` settles `{ok:true}`.
 */
interface CallState {
  job?: CreatedJob;
  reservation?: ReservedJob;
  jobReady: Promise<CreatedJob | undefined>;
  resolveJobReady: (job: CreatedJob | undefined) => void;
}

function createCallState(): CallState {
  let resolveJobReady: (job: CreatedJob | undefined) => void = () => {};
  const jobReady = new Promise<CreatedJob | undefined>((resolve) => {
    resolveJobReady = resolve;
  });
  return { jobReady, resolveJobReady };
}

export function createBashTool(deps: BashToolDeps): ToolDefinition<typeof BashToolParams, BashOverrideDetails> {
  const warn = deps.warn ?? ((message: string) => console.warn(`[pi-subagent] ${message}`));
  const now = deps.now ?? (() => Date.now());
  // §2.1: renderers do not depend on `operations`, so one stateless definition
  // (never executed) supplies the whole static surface and both renderers.
  const surface = createBashToolDefinition(process.cwd());
  const thresholdForDescription = safeThreshold(deps, warn);
  const deadlineSurface = safeDeadlineSurface(deps, warn);
  // §3.6: the static no-host-view fallback warns once per tool instance.
  let warnedStaticDeadline = false;

  return {
    name: "bash",
    label: surface.label,
    description:
      surface.description + formatDescriptionSuffix(thresholdForDescription) + formatDeadlineSuffix(deadlineSurface),
    ...(surface.promptSnippet !== undefined ? { promptSnippet: surface.promptSnippet } : {}),
    ...(surface.promptGuidelines !== undefined ? { promptGuidelines: [...surface.promptGuidelines] } : {}),
    parameters: BashToolParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const manager = deps.manager();
      const thresholdMs = safeThreshold(deps, warn);
      const innerParams: InnerParams = {
        command: params.command,
        ...(params.timeout !== undefined ? { timeout: params.timeout } : {}),
      };

      // §2.6 / feature-off (threshold 0, or no session stack behind the
      // holder): nothing to manage, so run pi's tool untouched.
      if (!manager || thresholdMs <= 0) {
        const passthrough = createBashToolDefinition(ctx.cwd);
        return runInner(passthrough, toolCallId, innerParams, signal, onUpdate, ctx);
      }

      // §3.8: an explicit background request over the cap is a config error the
      // model can correct — and it is raised *before* anything spawns, so no
      // process is left dangling behind the rejection. (§3.6: this is the only
      // spawn path still bound by the cap — child-session auto-backgrounding
      // may exceed it, C2.)
      if (params.run_in_background === true && !manager.hasBackgroundCapacity()) {
        throw capacityError(manager.maxBackgroundJobs);
      }

      const childMode = deps.host !== undefined;
      const view = childMode ? safeHostView(deps, warn) : undefined;

      // ── §3.6 R computation ────────────────────────────────────────────────
      // D = hostView.watchdogDueAt() (same source as the watchdog, E2). No
      // view attached but a tool budget known ⇒ static D = start + toolBudget
      // (warn once). A view that answers `undefined`, or neither present ⇒ no
      // D ⇒ no truncation (today's semantics).
      const startedAt = now();
      let deadlineAt: number | undefined;
      if (childMode) {
        if (view !== undefined) deadlineAt = readWatchdogDue(view, warn);
        else {
          const budget = safeToolBudget(deps, warn);
          if (budget > 0) {
            deadlineAt = startedAt + budget;
            if (!warnedStaticDeadline) {
              warnedStaticDeadline = true;
              warn(
                `bash auto-background: no host view attached; using the static tool budget ` +
                  `(${budget}ms) as the return deadline for this call`,
              );
            }
          }
        }
      }
      const rWaitMs =
        deadlineAt === undefined
          ? thresholdMs
          : Math.min(thresholdMs, Math.max(0, deadlineAt - MARGIN_RETURN_MS - startedAt));

      const state = createCallState();
      let forwardAbort = true;
      let forwardUpdates = true;
      let listenerAttached = false;
      const relay = new AbortController();
      const onAbort = (): void => {
        // §2.4: once the call has been handed back (latch taken) a caller
        // abort must not reach the process; before that it is forwarded and
        // the inner path kills/cancels exactly like the built-in tool.
        if (forwardAbort) relay.abort();
      };
      // Entering already aborted keeps the built-in semantics exactly: the
      // relay is pre-aborted, so `exec` throws "aborted" before spawning.
      if (signal?.aborted) relay.abort();
      else if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        listenerAttached = true;
      }
      const stopForwarding = (): void => {
        forwardAbort = false;
        if (listenerAttached) {
          signal?.removeEventListener("abort", onAbort);
          listenerAttached = false;
        }
      };

      const operations: BashOperations = {
        exec: (command, cwd, options) => execViaManager(manager, state, command, cwd, options),
      };
      const inner = createBashToolDefinition(ctx.cwd, { operations });
      const gatedUpdate = onUpdate
        ? (update: Parameters<NonNullable<typeof onUpdate>>[0]) => {
            if (forwardUpdates) onUpdate(update);
          }
        : undefined;

      // Deferred outer result: the latch callbacks below resolve/reject it.
      let resolveOuter!: (result: OuterResult) => void;
      let rejectOuter!: (error: unknown) => void;
      const outer = new Promise<OuterResult>((resolve, reject) => {
        resolveOuter = resolve;
        rejectOuter = reject;
      });

      let innerPromise: Promise<Awaited<ReturnType<typeof runInner>>>;
      try {
        innerPromise = runInner(inner, toolCallId, innerParams, relay.signal, gatedUpdate, ctx);
      } catch (error) {
        // Defensive: `execute` is async, so this is unreachable in practice.
        stopForwarding();
        throw error;
      }
      // Nothing may observe this promise until the race is decided, but an
      // early rejection must not surface as an unhandled rejection either.
      const settled = innerPromise.then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      // ── §3.6 single atomic adjudication (the latch) ───────────────────────
      // Both flags are only ever assigned inside synchronous callback
      // prologues (settled.then / R timer / abort→relay paths all funnel into
      // one of these), so a same-tick arrival has exactly one winner.
      let backgrounded = false;
      let foregroundDone = false;
      let capacityNote = false;
      let rTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        stopForwarding();
        if (rTimer !== undefined) {
          clearTimeout(rTimer);
          rTimer = undefined;
        }
      };

      const deliverForeground = (outcome: Settled): void => {
        if (backgrounded || foregroundDone) return;
        foregroundDone = true;
        cleanup();
        if (outcome.ok) {
          resolveOuter(capacityNote ? appendCapacityNote(outcome.result, manager.maxBackgroundJobs) : outcome.result);
        } else rejectOuter(outcome.error);
      };
      settled.then(deliverForeground);

      const deliverSettledOutcome = (outcome: Settled): void => {
        if (outcome.ok) {
          resolveOuter(capacityNote ? appendCapacityNote(outcome.result, manager.maxBackgroundJobs) : outcome.result);
        } else rejectOuter(outcome.error);
      };

      const takeBackground = (): void => {
        if (backgrounded || foregroundDone) return;
        // §3.8: a main-session threshold hit against a full table stays in the
        // foreground (with the capacity note). Child sessions convert anyway
        // (§3.6 C2: only run_in_background spawns are bound by the cap).
        if (!childMode && !manager.hasBackgroundCapacity()) {
          warn(
            `bash job ${state.reservation?.jobId ?? state.job?.jobId ?? "(pending)"} stayed in the foreground: ` +
              `all ${manager.maxBackgroundJobs} background slots are in use`,
          );
          capacityNote = true;
          return; // the trigger is spent; settled will deliver the foreground outcome
        }
        // The latch is taken NOW, at trigger time — a command settling while
        // we still wait for its pid must not steal the call back into the
        // foreground (today's race resolved the same way).
        backgrounded = true;
        cleanup();
        forwardUpdates = false;
        // §3.6 boundary telemetry: a child session reports the instant control
        // returns at R (the host correlates it against this toolCallId's
        // tool_end to measure return lag). Only the child-mode R return is a
        // deadline race — foreground and main-session returns are not.
        if (childMode && view !== undefined) {
          try {
            view.noteToolReturn(toolCallId, now());
          } catch {
            /* telemetry must never break the return path */
          }
        }

        const autoBackgrounded = params.run_in_background !== true;
        const elapsedMs = now() - startedAt;

        // §3.6/P4 acceptance: the background branch never awaits
        // `markBackgrounded` — the manager's synchronous memory write is enough
        // to hand the call back; persistence is write-behind through the
        // store's chain (R5/R10).
        const handOff = (jobId: JobId): void => {
          manager.markBackgroundedSync(jobId);
        };

        const finishWithJob = (known: CreatedJob): void => {
          resolveOuter({
            content: [
              {
                type: "text" as const,
                text: autoBackgrounded
                  ? formatAutoBackgroundText(known.jobId, elapsedMs, known.logPath)
                  : formatExplicitBackgroundText(known.jobId, known.pid, known.logPath),
              },
            ],
            details: {
              jobId: known.jobId,
              background: true,
              ...(autoBackgrounded ? { autoBackgrounded: true as const } : {}),
              pid: known.pid,
              logPath: known.logPath,
            } satisfies BashBackgroundDetails,
          });
        };

        if (state.job !== undefined) {
          // The pid is already known: hand the call back right here.
          const job = state.job;
          adoptInnerPromise(manager, job.jobId, settled, warn);
          handOff(job.jobId);
          finishWithJob(job);
          return;
        }
        if (childMode && state.reservation !== undefined) {
          // §3.6: the spawn has not produced a pid yet — return now, the job
          // finishes starting up in the background (`pid starting`).
          const reservation = state.reservation;
          adoptInnerPromise(manager, reservation.jobId, settled, warn);
          handOff(reservation.jobId);
          resolveOuter({
            content: [
              {
                type: "text" as const,
                text: autoBackgrounded
                  ? formatAutoBackgroundTextStarting(reservation.jobId, elapsedMs, reservation.logPath)
                  : formatExplicitBackgroundTextStarting(reservation.jobId, reservation.logPath),
              },
            ],
            details: {
              jobId: reservation.jobId,
              background: true,
              ...(autoBackgrounded ? { autoBackgrounded: true as const } : {}),
              logPath: reservation.logPath,
            } satisfies BashBackgroundDetails,
          });
          return;
        }

        // Main session (or a reservation that never happened — the inner call
        // is already settling): today's semantics — wait for the pid (bounded
        // by started's R12 budget) or for the inner result if the spawn never
        // completes.
        void (async () => {
          try {
            const awaited = await Promise.race([state.jobReady, settled.then(() => undefined)]);
            if (awaited !== undefined) {
              adoptInnerPromise(manager, awaited.jobId, settled, warn);
              handOff(awaited.jobId);
              finishWithJob(awaited);
            } else deliverSettledOutcome(await settled);
          } catch (error) {
            rejectOuter(error);
          }
        })();
      };

      // Arm the background triggers.
      if (params.run_in_background === true) {
        if (childMode) {
          // §3.6 ③: reserve has already returned (E33 — pi's execute reaches
          // ops.exec with no prior await), so the latch fires right here.
          takeBackground();
        } else {
          // §2.2: today's semantics — wait for the pid before handing back.
          void state.jobReady.then(() => takeBackground());
        }
      } else if (rWaitMs <= 0) {
        // §3.6 "R ≤ now" (e.g. toolMs ≤ MARGIN_RETURN): return at once,
        // without waiting for a pid.
        takeBackground();
      } else {
        // The R timer. At trigger time there is nothing to re-read: the only
        // decision left is "hand the call back now", which is what happens.
        rTimer = unrefTimer(setTimeout(takeBackground, rWaitMs));
      }

      return outer;
    },

    renderCall(args, theme, context) {
      // Delegation, not reimplementation: the extra `run_in_background` field
      // is simply ignored by pi's `$ <command>` renderer.
      return surface.renderCall!(args as never, theme, context as never);
    },

    renderResult(result, options, theme, context) {
      // Background results carry our own details shape, which pi's renderer
      // treats as "no truncation, no temp file" — plain text (§2.1).
      return surface.renderResult!(result as never, options, theme, context as never);
    },
  };
}

type InnerDefinition = ReturnType<typeof createBashToolDefinition>;
type InnerResult = Awaited<ReturnType<InnerDefinition["execute"]>>;
/** The background hand-back result (§2.2/§3.6) — pi's renderer shows it as plain text. */
type BackgroundResult = { content: { type: "text"; text: string }[]; details: BashBackgroundDetails };
type OuterResult = InnerResult | BackgroundResult;

function runInner(
  definition: InnerDefinition,
  toolCallId: string,
  params: InnerParams,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: ExtensionContext,
): Promise<InnerResult> {
  return definition.execute(toolCallId, params as never, signal, onUpdate as never, ctx);
}

type Settled = { ok: true; result: InnerResult } | { ok: false; error: unknown };

/** §3.8 foreground fallback: annotate the successful result, never the rejection. */
function appendCapacityNote(result: InnerResult, maxBackgroundJobs: number): InnerResult {
  const note = formatCapacityNote(maxBackgroundJobs);
  const content = [...result.content];
  const last = content.length - 1;
  const tail = last >= 0 ? content[last] : undefined;
  if (tail && tail.type === "text") content[last] = { ...tail, text: `${tail.text}\n\n${note}` };
  else content.push({ type: "text", text: note });
  return { ...result, content };
}

/**
 * §2.3: once the call has returned, the inner promise has no consumer left.
 * The manager takes it over — the built-in final text (including
 * "Command exited with code N") becomes the job's `finalText`, and the
 * rejection can never reach `process.on("unhandledRejection")` (T9).
 */
function adoptInnerPromise(
  manager: BashJobManager,
  jobId: JobId,
  settled: Promise<Settled>,
  warn: (message: string) => void,
): void {
  void settled
    .then((outcome) => {
      const text = outcome.ok ? innerResultText(outcome.result) : errorText(outcome.error);
      return manager.setFinalText(jobId, text);
    })
    .catch((error: unknown) => {
      warn(`bash job ${jobId} final text could not be recorded: ${String(error)}`);
    });
}

function innerResultText(result: InnerResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The plugin's `BashOperations.exec` (§1 ①): pi's inner tool still owns output
 * accumulation and result formatting, while the process itself is created and
 * owned by `BashJobManager` so it can outlive this call.
 *
 * Semantics replicated from `createLocalShellOperations`
 * (`dist/core/tools/bash.js:38-114`): pre-aborted signal throws before
 * spawning, abort kills the tree and throws `"aborted"`, an expired `timeout`
 * kills the tree and throws `timeout:<s>`, otherwise the exit code is
 * returned (`null` when signalled).
 *
 * §3.6: the local timeout timer is gone — the `timeoutMs` travels to the
 * manager inside `reserve()` and the deadline (foreground kill / grace /
 * extend) is adjudicated there; this layer only translates a `timed_out` exit
 * record back into pi's `timeout:<s>` error so the foreground text stays
 * byte-identical. Abort while `started` is pending ⇒ sync `cancelReserve` +
 * `aborted` (nothing spawned yet); abort after ⇒ `cancelReserve` (a kill for
 * a running job) and the exit is still awaited before `aborted` is thrown —
 * pi's own `waitForChildProcess`-then-check semantics, so the drain flushes
 * the process's last output through `onData` before the caller sees the
 * rejection.
 */
async function execViaManager(
  manager: BashJobManager,
  state: CallState,
  command: string,
  cwd: string,
  options: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ exitCode: number | null }> {
  const timeoutMs = resolveTimeoutMs(options.timeout);
  if (options.signal?.aborted) {
    state.resolveJobReady(undefined);
    throw new Error("aborted");
  }

  return execViaReserve(manager, state, command, cwd, options, timeoutMs);
}

/** §3.6 inner layer over `reserve()` / `started` / `job.exit`. */
async function execViaReserve(
  manager: BashJobManager,
  state: CallState,
  command: string,
  cwd: string,
  options: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
  timeoutMs: number | undefined,
): Promise<{ exitCode: number | null }> {
  let reservation: ReservedJob;
  try {
    reservation = manager.reserve({
      command,
      cwd,
      ...(options.env !== undefined ? { env: options.env } : {}),
      onData: (chunk) => options.onData(Buffer.from(chunk, "utf8")),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  } catch (error) {
    state.resolveJobReady(undefined);
    throw error;
  }
  state.reservation = reservation;
  // jobReady (the pid-bearing job) follows started; `{ok:false}` resolves it
  // undefined so the outer layer falls back to the inner result.
  void reservation.started.then(
    (outcome) => {
      if (outcome.ok) {
        state.job = outcome.job;
        state.resolveJobReady(outcome.job);
      } else state.resolveJobReady(undefined);
    },
    () => state.resolveJobReady(undefined), // defensive: started never rejects (R12)
  );

  // Abort ⇒ synchronously cancel (all three staged/running substates, §3.6).
  // The `abortSignal` rejection only guards the `await started` race (nothing
  // has spawned yet, so there is no exit worth waiting for); once the job is
  // running, an abort cancels/kills it and the exit below is still awaited.
  let onAbortReserve: (() => void) | undefined = undefined;
  const abortSignal = new Promise<never>((_resolve, reject) => {
    onAbortReserve = () => reject(new Error("aborted"));
  });
  // The rejection must never become an unhandledRejection when nobody is
  // racing it anymore.
  void abortSignal.catch(() => undefined);
  const handleAbort = (): void => {
    manager.cancelReserve(reservation.jobId);
    onAbortReserve?.();
  };
  try {
    if (options.signal) {
      if (options.signal.aborted) handleAbort();
      else options.signal.addEventListener("abort", handleAbort, { once: true });
    }
    const started = await Promise.race([reservation.started, abortSignal]);
    if (!started.ok) throw started.error;
    // pi's own semantics (built-in `waitForChildProcess` → aborted check):
    // the exit is awaited unconditionally — a caller abort kills the job via
    // `cancelReserve` and the bounded exit/drain finalization flushes the
    // process's remaining output through `onData` before the rejection, so
    // the foreground error text stays byte-identical to the built-in tool.
    const record = await started.job.exit;
    if (options.signal?.aborted) throw new Error("aborted");
    if (record.status === "timed_out") throw new Error(`timeout:${options.timeout}`);
    return { exitCode: record.exitCode };
  } finally {
    if (options.signal) options.signal.removeEventListener("abort", handleAbort);
  }
}

function safeThreshold(deps: BashToolDeps, warn: (message: string) => void): number {
  try {
    const value = deps.autoBackgroundMs();
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (error) {
    warn(`bash auto-background threshold unavailable (feature disabled for this call): ${String(error)}`);
    return 0;
  }
}

function safeDeadlineSurface(deps: BashToolDeps, warn: (message: string) => void): BashDeadlineSurface | undefined {
  if (deps.deadline === undefined) return undefined;
  try {
    return deps.deadline();
  } catch (error) {
    warn(`bash deadline settings unavailable (surface suffix omitted): ${String(error)}`);
    return undefined;
  }
}

function safeToolBudget(deps: BashToolDeps, warn: (message: string) => void): number {
  if (deps.toolBudgetMs === undefined) return 0;
  try {
    const value = deps.toolBudgetMs();
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  } catch (error) {
    warn(`bash tool budget unavailable (no static return deadline): ${String(error)}`);
    return 0;
  }
}

function readWatchdogDue(view: HostRunView, warn: (message: string) => void): number | undefined {
  try {
    const value = view.watchdogDueAt();
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
    return value;
  } catch (error) {
    warn(`bash host watchdog view unavailable (no return deadline truncation): ${String(error)}`);
    return undefined;
  }
}

function safeHostView(deps: BashToolDeps, warn: (message: string) => void): HostRunView | undefined {
  try {
    return deps.host?.();
  } catch (error) {
    warn(`bash host view unavailable (treating as unattached): ${String(error)}`);
    return undefined;
  }
}
