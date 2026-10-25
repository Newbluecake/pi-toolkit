/**
 * Scheduled tasks — per-session executor assembly (plan r3 §12 I1).
 *
 * `src/stack.ts` (assembly only, invariant I7) calls `installScheduleExecutors` once per session stack,
 * right after the stack built its `ScheduleAgent` and BEFORE `agent.start()`:
 *   1. `message.attach(agent, ctx)` — A2: registers the `message` executor (without it a message task is
 *      refused `E_UNSUPPORTED` by A0's preflight);
 *   2. `installBackgroundExecutor` — A1: the `background` executor + the result-note machinery, with the
 *      handoff adapter that routes a finished background run to A2's dispatcher.
 *
 * The handoff adapter owns the fall-back rule of A2's contract: `dropped` / `unknown` (and an unaccepted
 * enqueue) become a QUIET result message carrying the SAME noteId, so the note proof (session file) still
 * finds it and nothing is lost. No logic beyond glue lives here; pi-free apart from the `ctx`/`pi` ports.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConsultWiring } from "../../consult/index.js";
import type { SpawnService } from "../../service/spawn-service.js";
import { installBackgroundExecutor, type BackgroundExecutor } from "./bg.js";
import type { MessageSchedulerInstall } from "./message.js";
import type { ScheduleResultMessage } from "./note.js";
import type { ScheduleAgent } from "./wire.js";

export interface ScheduleExecutorsDeps {
  /** Activate-level A2 installer (`ScheduleWiring.message`); absent ⇒ every handoff degrades to a quiet recap. */
  message: MessageSchedulerInstall | undefined;
  spawn: Pick<SpawnService, "spawn" | "waitOutcome">;
  /** @deprecated #40 — consult removed; never read. Removed in PS1b. */
  consult?: Pick<ConsultWiring, "resolveExperts">;
}

/** Remove the "please take over" tail: a recap informs, it must not invite a turn. */
export function recapOf(message: ScheduleResultMessage): ScheduleResultMessage {
  return {
    ...message,
    content: message.content.replace(/\n请接手处理。$/, ""),
    details: { ...message.details, kind: "handoff-recap" },
  };
}

export function installScheduleExecutors(
  pi: Pick<ExtensionAPI, "sendMessage">,
  ctx: ExtensionContext,
  schedule: ScheduleAgent,
  deps: ScheduleExecutorsDeps,
): BackgroundExecutor | undefined {
  // Only an interactive stack with a process identity can ever execute (§3.3): nothing to install otherwise
  // (print / json / secure / child / --no-session keep the A0 refusal path, zero extra surface).
  if (!schedule.mode.arm || schedule.holder === undefined || schedule.sessionId === undefined) return undefined;
  deps.message?.attach(schedule, ctx);

  const sendQuiet = (message: ScheduleResultMessage): void => {
    try {
      // A late callback from a replaced session must not write into the NEW one.
      if (schedule.isDisposed() || ctx.sessionManager.getSessionId() !== schedule.sessionId) return;
      pi.sendMessage(message, { triggerTurn: false });
    } catch {
      /* stale ctx: the pending note is re-verified / re-delivered by the next stack (§6.3) */
    }
  };

  return installBackgroundExecutor(schedule, {
    spawn: deps.spawn,
    notes: {
      currentSessionId: () => ctx.sessionManager.getSessionId(),
      sessionFile: () => ctx.sessionManager.getSessionFile(),
      isIdle: () => ctx.isIdle(),
      sendMessage: (message, options) => pi.sendMessage(message, options),
      handoff: ({ run, task, message }) => {
        const installer = deps.message;
        if (installer === undefined) return false;
        // One quiet recap per handoff, whatever the number of terminal callbacks (I1 review r1 #5).
        let recapped = false;
        return installer.enqueueHandoff({
          runKey: run.runKey,
          taskId: task.id,
          task,
          // The authorization the source run was admitted under: A2 refuses the send when the task changed since.
          defHash: run.defHash,
          // Claim time of the source run: a pause/delete after it revokes this handoff (revocation generation).
          startedAt: run.startedAt,
          noteId: message.details.noteId,
          content: message.content,
          onEnd: (outcome) => {
            if ((outcome.kind === "dropped" || outcome.kind === "unknown") && !recapped) {
              recapped = true;
              sendQuiet(recapOf(message));
            }
            // continued / settled: the main session took the report over; A1's note proof (session file) decides `written`.
          },
        });
      },
    },
  });
}
