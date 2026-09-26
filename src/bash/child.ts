import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { systemClock } from "../core/clock.js";
import type { Clock } from "../core/clock.js";
import type { Millis, RunExitFacts, RunExitJob } from "../core/types.js";
import type { AgentSettings } from "../config/settings.js";
import { formatDuration } from "../core/format.js";
import { createBashJobManager, type BashJobManager, type KillJobResult } from "./manager.js";
import { createJobStore } from "./job-store.js";
import { createProcessPort } from "./process.js";
import { sanitizeSessionDirName } from "./session-dirs.js";
import { isTerminalJobStatus, previewCommand, type JobId, type JobRecord } from "./types.js";
import { getChildBashRegistry, type ChildBashRegistry, type KillAllReport } from "./child-registry.js";
import { createBashTool } from "../tools/bash-tool.js";
import { createBashJobTool } from "../tools/bash-job-tool.js";

/**
 * bash-timeout-grace plan §3.4-3.7 (P5): the child (subagent) session half of
 * the auto-background feature. Registered pre-guard, once per `activate()`
 * (AGENTS.md: no module-scope mutable state — every closure below lives
 * inside `wireChildBashJobs`'s own call, rebuilt fresh per activate()).
 *
 * Condition to call this at all (index.ts): `isChildSession &&
 * bashJobsEnabled(preGuardSettings) && preGuardSettings.bashJobs.childSessions`.
 *
 * Mirrors `src/stack.ts`'s main-session wiring (`buildBashJobManager` +
 * `createBashTool`/`createBashJobTool` registration in `src/index.ts`) but:
 *  - the manager is `owner: "subagent"` and gated by `admit()` on the process-
 *    global `ChildBashRegistry`'s seal state (§3.6 S1);
 *  - `host`/`toolBudgetMs` are wired so the tools return before the run's own
 *    watchdog/tool deadline (§3.6) — the host view itself is attached by the
 *    MAIN session (src/stack.ts, `registry.attachHost`) and read here through
 *    the SAME process-global registry (`Symbol.for`, survives across the
 *    main/child session boundary because both live in one Node process);
 *  - completion never sends a proactive message (§3.7 — the model reads
 *    `bash_job status/wait`, the settle-hold summary, or the exit facts);
 *  - a settling run with non-terminal jobs is held and reminded instead of
 *    finishing immediately (§3.5).
 */
export interface WireChildBashJobsOptions {
  settings: AgentSettings;
  clock?: Clock;
  warn?: (message: string) => void;
}

/** §3.5: fixed constants (not settings — see plan §9's risk table on low idleMs). */
const W_HOLD_MS: Millis = 120_000;
const MARGIN_HOLD_MS: Millis = 15_000;
const HOLD_MIN_MS: Millis = 5_000;

/** A resolve-only gate: `fire()` wakes every current waiter and re-arms for the next episode. */
function createGate(): { wait(): Promise<void>; fire(): void } {
  let resolve: () => void;
  let promise = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    wait: () => promise,
    fire: () => {
      const r = resolve;
      promise = new Promise((next) => {
        resolve = next;
      });
      r();
    },
  };
}

function mapExitState(status: JobRecord["status"]): RunExitJob["state"] {
  switch (status) {
    case "completed":
    case "failed":
    case "timed_out":
    case "killed":
      return status;
    case "staged":
    case "running":
      return "terminating";
    // `exited_unknown` / `orphaned` have no dedicated RunExitJob state (P0b
    // frozen union) — both are crash-recovery edge cases, not something a
    // live child session's own exitFacts() should normally ever see; render
    // them as "failed" (closest semantic: an unusable/unknown outcome).
    default:
      return "failed";
  }
}

/** §3.1 `ChildBashEntry.exitFacts()`: sync, read-only, capped at 5 entries. */
function buildExitFacts(manager: BashJobManager, seen: ReadonlySet<JobId>, clock: Clock): RunExitFacts {
  const relevant = manager
    .list()
    .filter((record) => !isTerminalJobStatus(record.status) || !seen.has(record.jobId))
    .sort((a, b) => (a.spawnedAt ?? a.createdAt) - (b.spawnedAt ?? b.createdAt));
  const capped = relevant.slice(0, 5);
  const now = clock.now();
  const bashJobs: RunExitJob[] = capped.map((record) => ({
    jobId: record.jobId,
    commandPreview: previewCommand(record.command, 60),
    state: mapExitState(record.status),
    exitCode: record.exitCode,
    logPath: record.logPath,
    durationMs: Math.max(0, (record.endedAt ?? now) - (record.spawnedAt ?? record.createdAt)),
    seen: seen.has(record.jobId),
  }));
  return { bashJobs, ...(relevant.length > 5 ? { bashJobsMore: relevant.length - 5 } : {}) };
}

/** §3.3 S3: kill every non-terminal job of this manager, bounded by the caller's own memoization. */
async function killAllNonTerminal(manager: BashJobManager, graceMs: number): Promise<KillAllReport> {
  const targets = manager.list().filter((record) => !isTerminalJobStatus(record.status));
  const killed: JobId[] = [];
  const alreadyDone: JobId[] = [];
  const orphaned: JobId[] = [];
  const pending: JobId[] = [];
  await Promise.all(
    targets.map(async (record) => {
      if (record.status === "staged") {
        // §3.3 S2 / §2.4 R12: a spawn still in flight (`reserve()`'s own
        // staged(persisting)/staged(spawning) sub-states) is cancelled
        // through the SAME mechanism an aborted tool call uses — never
        // `manager.kill()`, which would stamp a stale terminal record onto
        // the entry while the real spawn is still resolving and race R12's
        // own "pid returned ⇒ check cancelled" synchronous check (the entry
        // would already be terminal, so the late pid's process could start
        // up completely untracked).
        manager.cancelReserve(record.jobId);
        const settled = await manager.waitExit(record.jobId, Math.max(graceMs, 1_000) + 5_000);
        if (settled?.status === "killed") killed.push(record.jobId);
        else if (settled !== undefined && isTerminalJobStatus(settled.status)) alreadyDone.push(record.jobId);
        else pending.push(record.jobId);
        return;
      }
      let result: KillJobResult;
      try {
        result = await manager.kill(record.jobId, { graceMs });
      } catch {
        pending.push(record.jobId);
        return;
      }
      if (result.alreadyTerminal || result.outcome === "already-dead") alreadyDone.push(record.jobId);
      else if (result.outcome === "refused") orphaned.push(record.jobId);
      else killed.push(record.jobId);
    }),
  );
  return { killed, alreadyDone, orphaned, pending };
}

/** §3.7 grace notice text — child-session wording (never `triggerTurn:true`, E11). */
function formatGraceNotice(record: JobRecord, now: Millis): string {
  const remainingMs = record.deadline?.graceUntil !== undefined ? Math.max(0, record.deadline.graceUntil - now) : 0;
  return (
    `\u23f3 Bash job ${record.jobId} ($ ${previewCommand(record.command, 60)}) hit its timeout and is in its ` +
    `grace window (killed in ${formatDuration(remainingMs)} unless extended). ` +
    `Call bash_job(action:"extend", job_id:"${record.jobId}", extend_s:<seconds>) to give it more time, or ` +
    `bash_job(action:"kill", job_id:"${record.jobId}") if you no longer need it.`
  );
}

/** §3.5: `R_wait = ceil(H / W_HOLD) + 2 + E + G0`; `cap = childSettleHoldMaxRounds || 2 * R_wait`. */
function computeHoldCap(
  configuredMax: number,
  hardDeadlineAt: number | undefined,
  t0: Millis,
  maxExtensions: number,
  nonTerminalWithDeadline: readonly JobRecord[],
): number {
  if (configuredMax > 0) return configuredMax;
  const h = hardDeadlineAt !== undefined ? Math.max(0, hardDeadlineAt - t0) : 0;
  const rWaitBase = Math.ceil(h / W_HOLD_MS) + 2 + Math.max(0, maxExtensions);
  const g0 = nonTerminalWithDeadline.reduce((sum, record) => {
    const deadline = record.deadline;
    if (!deadline) return sum;
    const remaining = deadline.policy.maxExtensions - deadline.extensions;
    return sum + Math.max(0, remaining);
  }, 0);
  return 2 * (rWaitBase + g0);
}

export function wireChildBashJobs(pi: ExtensionAPI, opts: WireChildBashJobsOptions): void {
  const clock = opts.clock ?? systemClock;
  const warn = opts.warn ?? ((message: string) => console.warn(`[pi-subagent] ${message}`));
  const registry: ChildBashRegistry = getChildBashRegistry();
  const config = opts.settings.bashJobs;

  let manager: BashJobManager | undefined;
  let sessionId = "";
  const seen = new Set<JobId>();
  const graceGate = createGate();
  // §3.5 round-budget bookkeeping — frozen at first entry into the hold for this run.
  let holdRounds = 0;
  let frozenT0: Millis | undefined;
  let frozenCap: number | undefined;
  let warnedNoHostView = false;

  /**
   * **Why this is not a `session_start` handler** (found mid-implementation,
   * confirmed against pi's own SDK sources, `dist/core/sdk.js` /
   * `dist/core/agent-session.js`): `session_start` is emitted exclusively
   * from inside `AgentSession.bindExtensions()` (`agent-session.js`, the
   * `await this._extensionRunner.emit(this._sessionStartEvent)` line) —
   * which is called ONLY by pi's own CLI runtime hosts (TUI/print/RPC mode).
   * `src/runtime/session-driver.ts`'s `PiSessionDriver` (what spawns every
   * subagent in this codebase) calls `createAgentSession()` and NEVER calls
   * `.bindExtensions()` on the result — so `session_start` never fires for a
   * child session we spawn ourselves, and a handler gated on it (the plan's
   * literal §3.4 wording) would simply never run. Every OTHER extension
   * event used below (`agent_before_settle`, and each tool's own `execute`)
   * IS emitted through the normal per-turn `ExtensionRunner.emit(...)` path,
   * which is wired up unconditionally inside the `AgentSession` constructor
   * (`_buildRuntime`) — independent of `bindExtensions` — so those fire
   * normally for a child session. The manager is therefore built LAZILY, on
   * the first `bash`/`bash_job` tool call this child session ever makes
   * (each tool's own `execute(toolCallId, params, signal, onUpdate, ctx)`
   * receives a live `ctx`, unlike this wiring function's own `pi`-only
   * `activate()`-time argument) — a run that never calls `bash` never builds
   * a manager and never registers into the registry, which is exactly
   * correct (nothing to seal/kill/report).
   */
  function ensureManager(ctx: ExtensionContext): BashJobManager | undefined {
    if (manager) return manager;
    let sid: string;
    try {
      sid = (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.() ?? "";
    } catch {
      sid = "";
    }
    if (!sid) return undefined; // No session id yet — caller's own manager()-returns-undefined fallback applies.
    sessionId = sid;
    const rootDir = config.dir ?? join(getAgentDir(), "bash-jobs");
    const dirName = sanitizeSessionDirName(sessionId);
    const store = createJobStore({
      dir: join(rootDir, dirName),
      retentionMs: config.retentionMs,
      clock,
      dirMode: 0o700,
      extraLogRoot: rootDir,
    });
    void mkdir(store.dir, { recursive: true, mode: 0o700 })
      .then(() => writeFile(join(store.dir, "session-id"), `${sessionId}\n`, { encoding: "utf8", mode: 0o600 }))
      .catch(() => undefined);
    const processPort = createProcessPort({
      ...(config.shellPath !== undefined ? { shellPath: config.shellPath } : {}),
      drainTimeoutMs: config.drainTimeoutMs,
    });
    const m = createBashJobManager({
      store,
      processPort,
      clock,
      sessionId,
      hostPid: process.pid,
      maxLogBytes: config.maxLogBytes,
      maxBackgroundJobs: config.maxBackgroundJobs,
      drainTimeoutMs: config.drainTimeoutMs,
      deadlinePolicy: {
        graceMs: config.timeoutGraceMs,
        maxExtensions: config.maxExtensions,
        maxTimeoutFactor: config.maxTimeoutFactor,
      },
      owner: "subagent",
      // §3.6 S1: a sealed run refuses new jobs synchronously (reserve() throws before spawning).
      admit: () => !registry.isSealed(sessionId),
      onDeadline: (record, kind) => {
        if (kind !== "grace") return; // "extended" has nothing new to tell the child agent beyond its own extend() reply.
        graceGate.fire();
        try {
          pi.sendMessage(
            {
              customType: "bash-job:grace",
              content: formatGraceNotice(record, clock.now()),
              display: true,
              details: { kind: "bash-job-grace", jobId: record.jobId, status: record.status },
            },
            // §3.7: never triggerTurn:true in a child session (E11) — this
            // either lands on the current turn's tail or, if idle, is
            // appended without starting a ghost turn.
            { triggerTurn: false },
          );
        } catch {
          /* best effort */
        }
      },
    });
    manager = m;
    registry.register({
      sessionId,
      exitFacts: () => buildExitFacts(m, seen, clock),
      killAll: (graceMs) => killAllNonTerminal(m, graceMs),
      onSealed: () => {
        graceGate.fire();
      },
    });
    return m;
  }

  // §3.4: registered once per activate() (which DOES run for child sessions,
  // unlike session_start — see `ensureManager`'s doc comment above). Each
  // tool's own `execute` lazily builds the manager on first use.
  pi.registerTool(
    wrapLazyInitBash(
      createBashTool({
        manager: () => manager,
        autoBackgroundMs: () => config.autoBackgroundMs,
        host: () => registry.hostView(sessionId),
        toolBudgetMs: () => opts.settings.budget.toolMs,
        deadline: () => ({
          graceMs: config.timeoutGraceMs,
          maxExtensions: config.maxExtensions,
          maxTimeoutFactor: config.maxTimeoutFactor,
        }),
        warn,
      }),
      ensureManager,
    ),
  );
  pi.registerTool(
    wrapLazyInitBashJob(
      wrapSeenTracking(
        createBashJobTool({
          manager: () => manager,
          host: () => registry.hostView(sessionId),
          deadline: () => ({
            graceMs: config.timeoutGraceMs,
            maxExtensions: config.maxExtensions,
            maxTimeoutFactor: config.maxTimeoutFactor,
          }),
        }),
        seen,
      ),
      ensureManager,
    ),
  );

  if (config.childSettleHold === false) return;

  pi.on(
    "agent_before_settle",
    async (event: AgentBeforeSettleEvent): Promise<AgentBeforeSettleEventResult | undefined> => {
      // §3.5 放行检查 1-5.
      if (event.outcome !== "completed") return undefined;
      if (!event.context.canContinue) return undefined;
      const m = manager; // Never built (no bash call this run) ⇒ nothing to hold for.
      if (!m || !sessionId || registry.isSealed(sessionId)) return undefined;
      const host = registry.hostView(sessionId);
      if (!host) {
        if (!warnedNoHostView) {
          warnedNoHostView = true;
          warn(
            "bash job settle-hold: no host view attached yet; skipping this settle (no watchdog bound to check against)",
          );
        }
        return undefined;
      }
      if (host.stopping()) return undefined;

      // §3.5 放行检查 6: 无非终态 job.
      const nonTerminal = m.list().filter((record) => !isTerminalJobStatus(record.status));
      if (nonTerminal.length === 0) return undefined;

      const now = clock.now();
      if (frozenT0 === undefined) {
        frozenT0 = now;
        frozenCap = computeHoldCap(
          config.childSettleHoldMaxRounds,
          host.hardDeadlineAt(),
          frozenT0,
          host.maxExtensions(),
          nonTerminal.filter((record) => record.deadline !== undefined),
        );
      }
      const cap = frozenCap ?? 1;

      // §3.5 放行检查 7: 轮次预算耗尽.
      if (holdRounds >= cap) return undefined;

      // §3.5 放行检查 8: 看门狗即将到期.
      const watchdogDue = host.watchdogDueAt();
      const hold = watchdogDue !== undefined ? Math.min(W_HOLD_MS, watchdogDue - now - MARGIN_HOLD_MS) : W_HOLD_MS;
      if (hold < HOLD_MIN_MS) return undefined;

      const ids = nonTerminal.map((record) => record.jobId);
      await Promise.race([m.waitAllExit(ids, hold), graceGate.wait(), registry.whenSealed(sessionId)]);

      if (registry.isSealed(sessionId) || host.stopping()) return undefined;
      holdRounds++;

      const after = m.list();
      const stillNonTerminal = after.filter((record) => !isTerminalJobStatus(record.status));
      const stillIds = new Set(stillNonTerminal.map((record) => record.jobId));
      const finishedThisRound = after.filter((record) => ids.includes(record.jobId) && !stillIds.has(record.jobId));
      const gracingNow = stillNonTerminal.filter(
        (record) => record.deadline?.graceUntil !== undefined && record.deadline.graceUntil <= now + hold,
      );

      let text: string;
      if (stillNonTerminal.length === 0) {
        const summary = finishedThisRound.map((record) => `${record.jobId} exit ${record.exitCode ?? "?"}`).join(", ");
        text = `Background bash job(s) finished: ${summary || "(none)"}. You may finish this run now.`;
        finishedThisRound.forEach((record) => seen.add(record.jobId));
      } else if (gracingNow.length > 0) {
        const list = gracingNow.map((record) => `${record.jobId} ($ ${previewCommand(record.command, 40)})`).join(", ");
        text =
          `\u23f3 Job(s) in grace window and about to be killed unless extended: ${list}. ` +
          `Use bash_job(action:"extend", ...) now if you still need them.`;
      } else {
        const running = stillNonTerminal
          .map((record) => `${record.jobId} ($ ${previewCommand(record.command, 40)})`)
          .join(", ");
        const doneSummary = finishedThisRound.length
          ? ` Finished since last reminder: ${finishedThisRound.map((r) => `${r.jobId} exit ${r.exitCode ?? "?"}`).join(", ")}.`
          : "";
        text =
          `\u23f3 Background bash job(s) still running (reminder ${holdRounds}/${cap}): ${running}.${doneSummary} ` +
          `Call bash_job(action:"wait", ...) to keep waiting, or bash_job(action:"kill", ...) if you no longer need them.` +
          (holdRounds === cap - 1
            ? ` Final reminder (${holdRounds}/${cap}): when this turn ends the run finishes and every running bash job is killed. ` +
              `Use bash_job(action:"wait") now if you still need the result.`
            : "");
      }
      const entry: SessionBoundaryDraft = {
        type: "custom_message",
        customType: "bash-job:settle-hold",
        content: text,
        display: true,
      };
      return { entries: [...event.entries, entry], continue: true };
    },
  );
}

/** Lazily builds the per-session manager on the tool's first real call — see `ensureManager`'s doc comment. */
function wrapLazyInitBash(
  tool: ReturnType<typeof createBashTool>,
  ensureManager: (ctx: ExtensionContext) => unknown,
): ReturnType<typeof createBashTool> {
  return {
    ...tool,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      ensureManager(ctx);
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/** Same as `wrapLazyInitBash`, for `bash_job`. */
function wrapLazyInitBashJob(
  tool: ReturnType<typeof createBashJobTool>,
  ensureManager: (ctx: ExtensionContext) => unknown,
): ReturnType<typeof createBashJobTool> {
  return {
    ...tool,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      ensureManager(ctx);
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/** §3.1: best-effort "was this job's terminal state ever returned to the model" tracker for `exitFacts().seen`. */
function wrapSeenTracking(
  tool: ReturnType<typeof createBashJobTool>,
  seen: Set<JobId>,
): ReturnType<typeof createBashJobTool> {
  return {
    ...tool,
    async execute(...args: Parameters<typeof tool.execute>) {
      const result = await tool.execute(...args);
      try {
        noteSeenFromDetails((result as { details?: unknown } | undefined)?.details, seen);
      } catch {
        /* display-only bookkeeping, never break the tool result */
      }
      return result;
    },
  };
}

function noteSeenFromDetails(details: unknown, seen: Set<JobId>): void {
  if (!details || typeof details !== "object") return;
  const rec = details as Record<string, unknown>;
  const single = rec;
  if (typeof single.jobId === "string" && single.terminal === true) seen.add(single.jobId);
  if (Array.isArray(rec.jobs)) {
    for (const entry of rec.jobs) {
      if (entry && typeof entry === "object") {
        const j = entry as Record<string, unknown>;
        if (typeof j.jobId === "string" && j.terminal === true) seen.add(j.jobId);
      }
    }
  }
}
