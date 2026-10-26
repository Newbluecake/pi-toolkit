/** A1: report bytes and terminal/index commit under S1's single writer lock. */
import { randomUUID } from "node:crypto";
import { sameHolder } from "../core/recovery.js";
import { RESULT_TOOL_NAME } from "../../core/tool-names.js";
import {
  isTerminalRunState,
  reportFileOf,
  SCHED_REPORT_MAX_BYTES,
  type Holder,
  type RunRecord,
  type ScheduleRunState,
  type ScheduleTask,
} from "../core/spec.js";
import {
  addPendingReport,
  findRun,
  finishRun,
  pendingReportFor,
  writeReportLocked,
  type GcCaps,
  type SessionStore,
  type TxBody,
  type TxCtx,
  type TxResult,
} from "../core/writer.js";
import type { ScheduleStateFile } from "../core/spec.js";

export interface BackgroundResult {
  state: ScheduleRunState;
  reason?: string;
  text: string;
}

/** Cuts on a UTF-8 boundary, without allocating a buffer proportional to an unbounded result. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const max = Math.max(0, Math.floor(maxBytes));
  // Each UTF-16 code unit needs at least one byte. Bound the conversion before allocating.
  const bytes = Buffer.from(text.slice(0, max), "utf8");
  if (bytes.length <= max) return bytes.toString("utf8");
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export function backgroundHeader(task: ScheduleTask, run: RunRecord): string {
  const when =
    run.kind === "manual"
      ? "立即运行"
      : new Intl.DateTimeFormat("zh-CN", {
          timeZone: task.when.tz,
          dateStyle: "short",
          timeStyle: "medium",
          hour12: false,
        }).format(run.scheduledAt);
  return `[定时任务 ${task.name} · ${when}]`;
}

function reportBytes(task: ScheduleTask, run: RunRecord, result: BackgroundResult): Buffer {
  const head = `${backgroundHeader(task, run)}\n\n状态：${result.state}${result.reason ? `（${result.reason}）` : ""}\n\n`;
  const suffix = run.runId
    ? `\n\n[报告已截断；完整输出请使用 ${RESULT_TOOL_NAME} ${run.runId}。]\n`
    : "\n\n[报告已截断；本次运行没有可查询的子任务全文。]\n";
  const prefix = truncateUtf8(head, 2048);
  const room = SCHED_REPORT_MAX_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  const text = truncateUtf8(result.text, room);
  return Buffer.from(prefix + text + (text.length < result.text.length ? suffix : ""), "utf8");
}

export interface BackgroundReportInput {
  store: SessionStore;
  run: RunRecord;
  task: ScheduleTask;
  holder: Holder;
  /** Must not touch ctx: checked while the writer lock is held, including after disposal. */
  isDisposed(): boolean;
  result: BackgroundResult;
  now: number;
  noteId?: string;
  caps?: GcCaps;
}
export type BackgroundReportResult =
  | { kind: "committed"; run: RunRecord }
  | { kind: "late" | "missing" | "foreign" | "closed" }
  | { kind: "error"; code: string; uncertain?: boolean };

export async function commitBackgroundReport(input: BackgroundReportInput): Promise<BackgroundReportResult> {
  const { store, run, result } = input;
  let skipped: "late" | "missing" | "foreign" | "closed" | undefined;
  let committed: RunRecord | undefined;
  // Persist handoff intent in the opaque random id so deleting/updating the task cannot make a
  // cross-process recap wake again or lose its kind. No storage-schema field is added.
  const noteId = input.noteId ?? `${input.task.bg?.handoff ? "handoff:" : ""}${randomUUID()}`;
  // writeReportLocked writes bytes BEFORE its commit callback. Interpose the ownership/terminal
  // check on its transact port so it happens UNDER THAT SAME LOCK, before any report IO. The
  // skipped value is deliberately never consumed as T; the public result uses `skipped` below.
  const guardedStore: SessionStore = {
    ...store,
    transact<T>(body: (draft: ScheduleStateFile, ctx: TxCtx) => TxBody<T>): Promise<TxResult<T>> {
      return store.transact<T>((draft, ctx) => {
        const current = findRun(draft, run.runKey);
        let write = false;
        if (current === undefined) skipped = "missing";
        else if (!sameHolder(current.holder, input.holder)) skipped = "foreign";
        else if (isTerminalRunState(current.state)) {
          skipped = "late";
          const before = current.lateOutcome;
          finishRun(draft, run.runKey, result, ctx.now);
          write = before !== current.lateOutcome;
        } else if (input.isDisposed()) {
          skipped = "closed";
          finishRun(draft, run.runKey, { state: "unknown", reason: "owner-closed" }, ctx.now);
          finishRun(draft, run.runKey, result, ctx.now);
          write = true;
        } else return body(draft, ctx);
        return { value: undefined as T, write };
      });
    },
  };
  const tx = await writeReportLocked(guardedStore, {
    reportFile: reportFileOf(run.taskId, run.scheduledAt, input.task.when.tz),
    allocateUnique: true,
    data: reportBytes(input.task, run, result),
    now: input.now,
    ...(input.caps === undefined ? {} : { caps: input.caps }),
    commit(draft, ctx, written, reportFile) {
      const verdict = finishRun(
        draft,
        run.runKey,
        {
          state: result.state,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          ...(written ? { reportFile } : { reason: "report-skipped(cap)" }),
          note: "pending",
          noteId,
        },
        ctx.now,
      );
      if (verdict === "ok") {
        const current = findRun(draft, run.runKey)!;
        if (written && input.task.feishu)
          addPendingReport(draft, pendingReportFor(store.sessionId, current, result.state), ctx.now);
        committed = structuredClone(current);
      }
      return { value: verdict, write: true };
    },
  });
  // An uncertain rename may have committed: never send a note based on its callback's value.
  if (!tx.ok) return { kind: "error", code: tx.code, ...(tx.uncertain ? { uncertain: true } : {}) };
  if (skipped !== undefined) return { kind: skipped };
  return committed === undefined ? { kind: "missing" } : { kind: "committed", run: committed };
}
