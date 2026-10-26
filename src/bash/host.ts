import { currentSessionId } from "../adapters/session-id.js";
import {
  BASH_JOB_NOTIFICATION_TYPE,
  bashJobElapsedMs,
  formatBashJobNotification,
  BASH_JOB_DEADLINE_NOTIFICATION_TYPE,
  formatBashJobGraceNotice,
  formatBashJobExtendedNotice,
  readBashJobTail,
} from "./notify.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { forwardBashJobs, type StackHolder } from "../holder.js";
import { createBashTool } from "./tool.js";
import { createBashJobTool } from "./job-tool.js";
import { isTerminalJobStatus } from "./types.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { systemClock } from "../core/clock.js";
import { createBashJobManager, type BashJobManager } from "./manager.js";
import { createJobStore } from "./job-store.js";
import { sanitizeSessionDirName } from "./session-dirs.js";
import { createProcessPort } from "./process.js";
import { type PiShellSettings } from "./pi-shell.js";
import type { AgentSettings } from "../config/settings.js";
import { type SendMessageFn } from "../service/background-completions.js";

/** bash-timeout-grace plan §3.2/§3.3 (P5): SIGTERM→SIGKILL grace for a sealed
 *  child session's still-running jobs — same value as `DEFAULT_KILL_GRACE_MS`
 *  (src/bash/process.ts), kept as an independent local constant so this
 *  meaning ("how long a just-ended run's jobs get to exit cleanly") does not
 *  drift with the manager's own per-call default. */
export const BASH_JOB_SEAL_GRACE_MS = 2_000;

/** bash-timeout-grace plan §3.6 (P5): half of `MARGIN_RETURN_MS` (bash-tool.ts) — a return that lands past this many ms after `noteToolReturn` warrants a one-time boundary-lag warning. */
export const BASH_JOB_TOOL_LAG_WARN_MS = 1_500;

/**
 * bash-timeout-grace plan §3.6 (P5, T32): pure correlation step — for every
 * `ToolCallRecord` in `toolHistory` that has both ended (`endedAt` set) and a
 * pending `noteToolReturn(toolCallId, at)` entry, computes the return lag
 * (`endedAt - at`), removes the entry from `pending` (matched once, never
 * re-checked), and warns exactly once per `toolCallId` when the lag exceeds
 * `BASH_JOB_TOOL_LAG_WARN_MS`. Mutates `pending`/`warned` in place (both are
 * the caller's own bounded bookkeeping maps/sets) and never throws.
 */
export function checkBashToolReturnLag(
  pending: Map<string, number>,
  warned: Set<string>,
  toolHistory: readonly { toolCallId: string; endedAt?: number }[] | undefined,
  warn: (message: string) => void,
): void {
  if (pending.size === 0 || !toolHistory) return;
  for (const call of toolHistory) {
    const at = pending.get(call.toolCallId);
    if (at === undefined || call.endedAt === undefined) continue;
    pending.delete(call.toolCallId);
    const lag = call.endedAt - at;
    if (lag > BASH_JOB_TOOL_LAG_WARN_MS && !warned.has(call.toolCallId)) {
      warned.add(call.toolCallId);
      warn(
        `bash auto-background return lag ${(lag / 1000).toFixed(1)}s (boundary ${(BASH_JOB_TOOL_LAG_WARN_MS * 2) / 1000}s)`,
      );
    }
  }
}

/**
 * §2.5/§2.6 (R6): the whole bash-job subsystem is off on win32 (no process
 * groups) and off when the threshold is 0. Read by `index.ts` to decide
 * whether the `bash` override and `bash_job` are registered at all, and here
 * to decide whether a manager (directory scan + poll timer) exists.
 */
export function bashJobsEnabled(settings: AgentSettings): boolean {
  return process.platform !== "win32" && settings.bashJobs.autoBackgroundMs > 0;
}

/**
 * bash auto-background §3/§5 assembly: store + process port + manager, with
 * the completion notice bound to `pi.sendMessage` (the manager itself has no
 * pi imports). A rejecting `notify` means "retry on the next poll", so
 * `notifiedAt` is only stamped once the message actually went out.
 *
 * ask-user-async §3.3 (P2): `send` overrides the completion-notice channel
 * (defaults to raw pi.sendMessage) so the hub mints/broadcasts on the REAL
 * send; the deadline channel (`onDeadline` grace/extended) deliberately keeps
 * raw pi.sendMessage — 用户拍板：bash 宽限/延长通知不打断。
 */
export function buildBashJobManager(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settings: AgentSettings,
  send?: SendMessageFn,
  piShell: PiShellSettings = {},
): BashJobManager {
  const sendCompletionNotice: SendMessageFn = send ?? ((message, options) => pi.sendMessage(message, options));
  const config = settings.bashJobs;
  const rootDir = config.dir ?? join(getAgentDir(), "bash-jobs");
  const sessionId = currentSessionId(ctx);
  const store = createJobStore({
    dir: join(rootDir, sanitizeSessionDirName(sessionId)),
    retentionMs: config.retentionMs,
    clock: systemClock,
    dirMode: 0o700,
    extraLogRoot: rootDir,
  });
  void mkdir(store.dir, { recursive: true, mode: 0o700 })
    .then(() => writeFile(join(store.dir, "session-id"), `${sessionId}\n`, { encoding: "utf8", mode: 0o600 }))
    .catch(() => undefined);
  const processPort = createProcessPort({
    ...(config.shellPath !== undefined ? { shellPath: config.shellPath } : {}),
    // 2026-10-17 revision: pi's own `shellPath` sits between the explicit
    // setting and pi's default chain in the resolution ladder.
    ...(piShell.shellPath !== undefined ? { piShellPath: piShell.shellPath } : {}),
    drainTimeoutMs: config.drainTimeoutMs,
  });
  // Late-bound: `notify` needs the manager it is being constructed with (to
  // read the log tail) — same pattern as widgetRef/spawnRef above.
  const managerRef: { current?: BashJobManager } = {};
  const manager = createBashJobManager({
    store,
    processPort,
    clock: systemClock,
    sessionId,
    hostPid: process.pid,
    maxLogBytes: config.maxLogBytes,
    maxBackgroundJobs: config.maxBackgroundJobs,
    drainTimeoutMs: config.drainTimeoutMs,
    // bash-timeout-grace plan §2/§4 (P5b): the main session gets the same
    // job-level deadline machinery as a child session (§3.4's
    // `createBashJobManager` call in `src/bash/child.ts`) — without this,
    // `deadlinePolicy` defaults to `DEFAULT_JOB_DEADLINE_POLICY` regardless
    // of what the user configured (`bashJobs.timeoutGraceMs`/`maxExtensions`/
    // `maxTimeoutFactor`), and `onDeadline` being unset means grace/extended
    // events never reach the model or the TUI.
    deadlinePolicy: {
      graceMs: config.timeoutGraceMs,
      maxExtensions: config.maxExtensions,
      maxTimeoutFactor: config.maxTimeoutFactor,
    },
    onDeadline: (record, kind) => {
      try {
        pi.sendMessage(
          {
            customType: BASH_JOB_DEADLINE_NOTIFICATION_TYPE,
            content:
              kind === "grace"
                ? formatBashJobGraceNotice(record, systemClock.now())
                : formatBashJobExtendedNotice(record, systemClock.now()),
            display: true,
            details: { kind: "bash-job-deadline", jobId: record.jobId, status: record.status, deadlineKind: kind },
          },
          // §4: a grace notice wakes the model into a decision turn; an
          // "extended" receipt is TUI-only (the tool's own return text
          // already told the model the same numbers).
          { triggerTurn: kind === "grace" },
        );
      } catch {
        /* best effort, mirrors notify() above */
      }
    },
    notify: async (record) => {
      const tail = managerRef.current ? await readBashJobTail(managerRef.current, record) : undefined;
      sendCompletionNotice(
        {
          customType: BASH_JOB_NOTIFICATION_TYPE,
          content: formatBashJobNotification(record, tail?.text, systemClock.now(), tail?.coversWholeLog),
          display: true,
          details: {
            kind: "bash-job",
            jobId: record.jobId,
            status: record.status,
            exitCode: record.exitCode,
            durationMs: bashJobElapsedMs(record, systemClock.now()),
            logPath: record.logPath,
          },
        },
        { triggerTurn: true },
      );
    },
  });
  managerRef.current = manager;
  return manager;
}

/** bash-timeout-grace plan §2.5 step 4/6 (P5): unref'd, default 10s. */
export const BASH_JOB_RECOVERY_DEADLINE_MS = 10_000;

/** bash-timeout-grace plan §2.5 step 6 (P5): unref'd, default 30s. */
export const BASH_JOB_RECONCILE_DEADLINE_MS = 30_000;

/**
 * bash-timeout-grace plan §2.5 step 4/6 (P5, “实施偏差记录” 2026-09-26): orchestrates
 * the two independent, unref'd `AbortController`-bounded phases of a stack
 * rebuild's bash-job recovery.
 *
 * `runRecovery` (crash-handoff adopt / migrate / `recover()`) is bounded by
 * `recoveryDeadlineMs` (default `BASH_JOB_RECOVERY_DEADLINE_MS`). Only once it
 * SETTLES (resolves or rejects) WITHOUT having been aborted (by its own timer
 * OR by `dispose()`) does `runCleanup` (directory reconciliation) get armed,
 * with its OWN fresh `AbortController` ("用户确认（v6）" P3 note: an already-
 * aborted controller cannot be rearmed — both controllers are created
 * up-front here instead, so `dispose()` can always abort both, even the one
 * whose phase has not started yet).
 *
 * `dispose()` aborts whichever phase(s) are still outstanding; idempotent,
 * safe to call more than once or after both phases have already settled.
 * Three orderings (T31): (a) recovery settles before its deadline ⇒ cleanup
 * is armed and runs its own bounded phase; (b) recovery's OWN timer fires
 * first ⇒ cleanup is never armed, `runCleanup` is never called, one warn;
 * (c) `dispose()` during recovery ⇒ both signals end up aborted, cleanup is
 * never armed; (d) `dispose()` during cleanup ⇒ only the cleanup signal is
 * (newly) aborted, its in-flight call sees it at its next checkpoint.
 */
export function scheduleBashJobRecovery(opts: {
  runRecovery: (signal: AbortSignal) => Promise<void>;
  runCleanup: (signal: AbortSignal) => Promise<void>;
  recoveryDeadlineMs?: number;
  reconcileDeadlineMs?: number;
  warn?: (message: string) => void;
}): { dispose(): void } {
  const warn = opts.warn ?? ((message: string) => console.warn(`[pi-subagent] ${message}`));
  const recovery = new AbortController();
  const cleanup = new AbortController();
  let disposed = false;

  const recoveryTimer = setTimeout(() => recovery.abort(), opts.recoveryDeadlineMs ?? BASH_JOB_RECOVERY_DEADLINE_MS);
  recoveryTimer.unref?.();
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

  void opts
    .runRecovery(recovery.signal)
    .catch((error: unknown) => {
      warn(`bash job recovery failed (jobs stay unadopted): ${String(error)}`);
    })
    .finally(() => {
      clearTimeout(recoveryTimer);
      if (disposed) return; // dispose() already aborted `cleanup` above; nothing left to arm.
      if (recovery.signal.aborted) {
        warn("bash job recovery cancelled (timeout|superseded); skipping this session's directory reconciliation");
        return;
      }
      cleanupTimer = setTimeout(() => cleanup.abort(), opts.reconcileDeadlineMs ?? BASH_JOB_RECONCILE_DEADLINE_MS);
      cleanupTimer.unref?.();
      void opts
        .runCleanup(cleanup.signal)
        .catch((error: unknown) => {
          warn(`bash job directory reconciliation failed: ${String(error)}`);
        })
        .finally(() => {
          if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
        });
    });

  return {
    dispose(): void {
      disposed = true;
      clearTimeout(recoveryTimer);
      recovery.abort();
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      cleanup.abort();
    },
  };
}

/**
 * The `bash` override + `bash_job` management tool (moved verbatim out of `activate()`, #56 batch 2 step 5-3).
 * The caller keeps the `bashJobsEnabled(settings)` gate; both tools read the manager through the holder at call time.
 */
export function registerBashTools(pi: ExtensionAPI, deps: { holder: StackHolder; settings: AgentSettings }): void {
  const { holder, settings } = deps;
  pi.registerTool(
    createBashTool({
      manager: forwardBashJobs(holder),
      autoBackgroundMs: () => settings.bashJobs.autoBackgroundMs,
      // 2026-10-17 shell-resolution revision: pi's `shellCommandPrefix`,
      // honoured exactly like pi's built-in bash tool (`${prefix}\n${command}`)
      // — read off the current stack (rebuilt per session_start, non-live).
      commandPrefix: () => holder.current?.bashShell?.shellCommandPrefix,
      // P5b: without this the main session's `timeoutGraceMs`/`maxExtensions`/
      // `maxTimeoutFactor` settings never reach the tool surface (the
      // description suffix stays off even when the manager's own
      // deadlinePolicy — src/bash/host.ts's `buildBashJobManager` — is enabled).
      deadline: () => ({
        graceMs: settings.bashJobs.timeoutGraceMs,
        maxExtensions: settings.bashJobs.maxExtensions,
        maxTimeoutFactor: settings.bashJobs.maxTimeoutFactor,
      }),
    }),
  );
  pi.registerTool(
    createBashJobTool({
      manager: forwardBashJobs(holder),
      // P5b: same as above — without this `bash_job`'s schema never gains
      // the `extend` action for the main session, no matter the settings.
      deadline: () => ({
        graceMs: settings.bashJobs.timeoutGraceMs,
        maxExtensions: settings.bashJobs.maxExtensions,
        maxTimeoutFactor: settings.bashJobs.maxTimeoutFactor,
      }),
    }),
  );
}

/** §3.7 `shutdownPolicy: "kill"` — signal every live job, wait at most `graceMs`. */
export async function killBashJobsBounded(bashJobs: BashJobManager, graceMs: number): Promise<void> {
  const live = bashJobs
    .list()
    .filter((record) => !isTerminalJobStatus(record.status) || bashJobs.hasOpenLocalHandle(record.jobId));
  if (live.length === 0) return;
  const kills = Promise.allSettled(live.map((record) => bashJobs.kill(record.jobId).catch(() => undefined)));
  await Promise.race([kills, new Promise<void>((resolve) => systemClock.setTimer(Math.max(0, graceMs), resolve))]);
}
