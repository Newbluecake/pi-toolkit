/** A1 §6.3: at-most-once result notes; disk entries alone prove delivery. */
import type { Clock, TimerHandle } from "../../core/clock.js";
import { systemClock } from "../../core/clock.js";
import { judgeHolder, sameHolder } from "../core/recovery.js";
import { readReportFile } from "../core/reader.js";
import { findSessionEntry, sessionFileAnchor, type FileAnchor } from "../core/session-proof.js";
import {
  isTerminalRunState,
  SCHED_CUSTOM_TYPE,
  SCHED_NOTE_SUMMARY_MAX_BYTES,
  SCHED_MAX_TASKS_PER_SESSION,
  SCHED_RUNS_PER_TASK,
  SCHED_QUIET_MS,
  type Holder,
  type RunRecord,
  type ScheduleTask,
} from "../core/spec.js";
import { findRun } from "../core/writer.js";
import { isEpochDisposed, type ScheduleAgent } from "./wire.js";
import { backgroundHeader, truncateUtf8 } from "./report-file.js";
import { RESULT_TOOL_NAME } from "../../core/tool-names.js";
import { absoluteReportPath } from "./result-reference.js";

export type ScheduleNoteOwner = Pick<
  ScheduleAgent,
  "mode" | "sessionId" | "epoch" | "self" | "holder" | "store" | "isDisposed" | "changed"
>;
export interface ScheduleResultMessage {
  customType: typeof SCHED_CUSTOM_TYPE;
  content: string;
  display: true;
  details: { kind: "result" | "handoff" | "handoff-recap"; runKey: string; runId?: string; noteId: string };
}
export interface ScheduleNoteDeps {
  currentSessionId(): string | undefined;
  sessionFile(): string | undefined;
  isIdle(): boolean;
  sendMessage(message: ScheduleResultMessage, options: { triggerTurn: false }): void;
  /** A2 owns wake/fence/token admission; a missing port degrades to a quiet recap. */
  handoff?(entry: { run: RunRecord; task: ScheduleTask; message: ScheduleResultMessage }): boolean | void;
  clock?: Clock;
}
export interface ScheduleNotes {
  deliver(runKey: string, summary: string, handoff: boolean): Promise<void>;
  /** Call on stack start / turn_start / idle poll. Never resend a same-process note. */
  flush(): Promise<void>;
  /** Call from agent_settled: proof is delayed through the quiet period and an isIdle check. */
  settled(): void;
  idle(): Promise<void>;
  dispose(): void;
}

function sameProcess(a: Holder, b: Holder): boolean {
  return a.pid === b.pid && a.start === b.start && a.host === b.host && a.boot === b.boot;
}
function sameNote(a: RunRecord, b: RunRecord): boolean {
  return (
    a.note === "pending" &&
    a.noteId === b.noteId &&
    (a.noteHolder === undefined
      ? b.noteHolder === undefined
      : b.noteHolder !== undefined && sameHolder(a.noteHolder, b.noteHolder))
  );
}

export function createScheduleNotes(schedule: ScheduleNoteOwner, deps: ScheduleNoteDeps): ScheduleNotes {
  const clock = deps.clock ?? systemClock;
  const holder = schedule.holder;
  const epoch = schedule.epoch;
  // Per-stack only. These anchors are NEVER reconstructed from a bare persistent offset.
  const anchors = new Map<string, FileAnchor>();
  let disposed = false;
  let quiet: TimerHandle | undefined;
  let chain = Promise.resolve();
  const live = (): boolean => {
    if (
      disposed ||
      schedule.isDisposed() ||
      schedule.mode.kind !== "interactive" ||
      schedule.epoch !== epoch ||
      holder === undefined
    )
      return false;
    try {
      return schedule.sessionId !== undefined && deps.currentSessionId() === schedule.sessionId;
    } catch {
      return false;
    }
  };
  const changed = () => {
    if (live()) schedule.changed();
  };
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    chain = chain.then(fn).catch(() => {
      /* Keep pending on IO/ctx failure; never infer absence. */
    });
    return chain;
  };
  const fileNow = (): string | undefined => {
    if (!live()) return undefined;
    try {
      return deps.sessionFile();
    } catch {
      return undefined;
    }
  };
  const idleNow = (): boolean => {
    if (!live()) return false;
    try {
      return deps.isIdle();
    } catch {
      return false;
    }
  };

  function summaryOf(run: RunRecord): string {
    const store = schedule.store();
    if (store !== undefined && run.reportFile !== undefined) {
      const r = readReportFile(store.root, store.dirName, run.reportFile);
      if (r.kind === "ok") return r.text;
    }
    return `状态：${run.state}${run.reason ? `（${run.reason}）` : ""}`;
  }
  function messageFor(
    run: RunRecord,
    task: ScheduleTask | undefined,
    summary: string,
    kind: ScheduleResultMessage["details"]["kind"],
  ): ScheduleResultMessage {
    const head = task === undefined ? `[定时任务 ${run.taskId}]` : backgroundHeader(task, run);
    const full = run.runId ? `${RESULT_TOOL_NAME} ${run.runId}` : absoluteReportPath(schedule.store(), run.reportFile);
    return {
      customType: SCHED_CUSTOM_TYPE,
      display: true,
      content: `${head}\n${truncateUtf8(summary, SCHED_NOTE_SUMMARY_MAX_BYTES)}${full ? `\n全文：${full}` : ""}${kind === "handoff" ? "\n请接手处理。" : ""}`,
      details: {
        kind,
        runKey: run.runKey,
        ...(run.runId === undefined ? {} : { runId: run.runId }),
        noteId: run.noteId!,
      },
    };
  }
  async function claimAndSend(
    snapshot: RunRecord,
    summary: string | undefined,
    handoff: boolean,
    resend: boolean,
  ): Promise<void> {
    if (!live() || holder === undefined) return;
    const store = schedule.store();
    const file = fileNow();
    if (store === undefined || file === undefined) return;
    const anchor = sessionFileAnchor(file);
    if (anchor === undefined) return;
    const tx = await store.transact((d) => {
      const run = findRun(d, snapshot.runKey);
      if (
        !live() ||
        run === undefined ||
        !sameNote(run, snapshot) ||
        run.noteId === undefined ||
        !isTerminalRunState(run.state)
      )
        return { value: undefined, write: false };
      // CAS holder under the writer lock: two views observing absence cannot both send.
      if (resend) {
        if (
          run.noteHolder === undefined ||
          sameProcess(run.noteHolder, holder) ||
          schedule.self === undefined ||
          judgeHolder(run.noteHolder, schedule.self, { currentEpoch: epoch, epochDisposed: isEpochDisposed })
            .liveness !== "dead"
        )
          return { value: undefined, write: false };
        // User ruling: without a frozen-schema counter, narrow §6.3's two resends to ONE.
        // Original sender == run holder. A changed note holder proves the resend was used.
        if (!sameHolder(run.noteHolder, run.holder)) {
          run.note = "unverified";
          return { value: undefined, write: true };
        }
      } else if (run.noteHolder !== undefined) return { value: undefined, write: false };
      run.noteHolder = holder;
      run.noteFileOffset = anchor.offset;
      return { value: { run: structuredClone(run), task: d.tasks.find((t) => t.id === run.taskId) }, write: true };
    });
    if (!tx.ok || !live()) return;
    if (tx.wrote) changed();
    if (tx.value === undefined) return;
    // No awaited boundary from the final epoch/sid check through host dispatch.
    if (anchors.size >= SCHED_MAX_TASKS_PER_SESSION * SCHED_RUNS_PER_TASK && !anchors.has(snapshot.runKey))
      anchors.delete(anchors.keys().next().value!);
    anchors.set(snapshot.runKey, anchor);
    const { run, task } = tx.value;
    const recap = run.noteId?.startsWith("handoff:") === true || task?.bg?.handoff === true;
    const kind =
      resend && recap ? "handoff-recap" : handoff && deps.handoff && task !== undefined ? "handoff" : "result";
    const text = summary ?? summaryOf(run);
    const message = messageFor(run, task, text, kind);
    if (!live()) return;
    if (kind === "handoff" && task !== undefined) {
      // false is authoritative non-admission, so this first delivery can safely become quiet.
      if (deps.handoff!({ run, task, message }) === false && live())
        deps.sendMessage(messageFor(run, task, text, "handoff-recap"), { triggerTurn: false });
    } else deps.sendMessage(message, { triggerTurn: false });
    // A quiet result can arrive while the owner is already idle (no future agent_settled event).
    if (idleNow()) api.settled();
  }
  async function verify(snapshot: RunRecord): Promise<void> {
    if (!live() || holder === undefined || snapshot.noteId === undefined) return;
    const previous = snapshot.noteHolder;
    const ours = previous !== undefined && sameProcess(previous, holder);
    // An old epoch in this SAME process can still have a pi memory-queued message. Never resend it.
    if (previous !== undefined && !ours) {
      if (
        schedule.self === undefined ||
        judgeHolder(previous, schedule.self, { currentEpoch: epoch, epochDisposed: isEpochDisposed }).liveness !==
          "dead"
      )
        return;
    }
    if (previous === undefined) {
      // No sender intent exists. Claiming for the first time is safe, including after a crash.
      await claimAndSend(snapshot, undefined, false, false);
      return;
    }
    const file = fileNow();
    if (file === undefined) return;
    const anchor = anchors.get(snapshot.runKey);
    const proof = findSessionEntry({
      file,
      key: "noteId",
      id: snapshot.noteId,
      ...(anchor === undefined ? { offset: 0 } : { anchor }),
      deadlineAt: performance.now() + 100,
    });
    if (!live()) return;
    if (proof.kind === "found" || proof.kind === "too-large") {
      const store = schedule.store();
      if (store === undefined) return;
      const tx = await store.transact((d) => {
        const run = findRun(d, snapshot.runKey);
        if (!live() || run === undefined || !sameNote(run, snapshot)) return { value: false, write: false };
        run.note = proof.kind === "found" ? "written" : "unverified";
        return { value: true, write: true };
      });
      if (tx.ok && tx.value) {
        anchors.delete(snapshot.runKey);
        changed();
      }
    } else if (proof.kind === "absent" && !ours) {
      await claimAndSend(snapshot, undefined, false, true);
    }
    // Inconclusive/refused is not absence; own-process absence is never a resend basis.
  }
  const api: ScheduleNotes = {
    deliver(runKey, summary, handoff) {
      return enqueue(async () => {
        if (!live()) return;
        const state = schedule.store()?.read();
        const run = state?.kind === "ok" ? findRun(state.state, runKey) : undefined;
        if (run?.note === "pending" && run.noteId !== undefined) await claimAndSend(run, summary, handoff, false);
      });
    },
    flush() {
      return enqueue(async () => {
        if (!idleNow()) return;
        const state = schedule.store()?.read();
        if (state?.kind !== "ok") return;
        for (const run of state.state.runs) {
          if (!idleNow()) break;
          if (run.form === "background" && isTerminalRunState(run.state) && run.note === "pending") await verify(run);
        }
      });
    },
    settled() {
      if (!live()) return;
      if (quiet !== undefined) clock.clearTimer(quiet);
      quiet = clock.setTimer(SCHED_QUIET_MS, () => {
        quiet = undefined;
        void api.flush();
      });
    },
    idle: () => chain,
    dispose() {
      disposed = true;
      if (quiet !== undefined) clock.clearTimer(quiet);
      quiet = undefined;
      anchors.clear();
    },
  };
  return api;
}
