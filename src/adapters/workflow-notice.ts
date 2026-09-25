import type { UsageDelta } from "../core/types.js";
import {
  WORKFLOW_SETTLED_EVENT,
  type BackgroundSettlePhase,
  type BackgroundWorkflowUsage,
  type BackgroundWorkflowView,
  type BackgroundWorkflows,
} from "../workflow/background.js";
import type { WorkflowOutcome } from "../workflow/types.js";
import {
  aggregateChildUsage,
  formatWorkflowNotification,
  formatWorkflowSummary,
  liveChildRunIds,
} from "../tools/workflow-tool.js";

/**
 * Background workflow completion notices (docs/dev/workflow-background/plan.md §3).
 *
 * Channel choice: workflows are not runs, so they do not ride the run
 * notification outbox (its payload is keyed by run id + generation and every
 * consumer — formatter, context-receipt tracker, caller-ack hold — reads the
 * run store). Instead this mirrors the bash-job notice: one
 * `pi.sendMessage(customType, triggerTurn: true)` per settled workflow.
 *
 * Persistence: while the session is live the message goes straight to pi (pi
 * appends it, or queues it as a steer while a turn streams — same guarantee
 * as a bash-job notice). A workflow that settles while the session is
 * shutting down (it was stopped by the shutdown, or finished inside that
 * window) is instead appended as a `pending` session entry; the next stack
 * built on that session file (after /reload, or when the session is resumed
 * later) re-delivers it once and appends a `delivered` marker. Re-delivery
 * does not trigger a turn — the workflow ended with its session, nothing is
 * waiting on it.
 */

export const WORKFLOW_NOTIFICATION_TYPE = "subagent:workflow-notification";
/** Session entry (`pi.appendEntry`) carrying a not-yet-delivered notice across a stack rebuild. */
export const WORKFLOW_NOTICE_ENTRY_TYPE = "subagent:workflow-notice";
export { WORKFLOW_SETTLED_EVENT };
/** Pending notices older than this are not re-delivered. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1_000;
/** At most this many pending notices are re-delivered per stack build (newest first). */
const MAX_REDELIVER = 10;

export interface WorkflowNotificationDetails {
  kind: "workflow";
  workflowId: string;
  label: string;
  status: WorkflowOutcome["status"];
  durationMs: number;
  summary: string;
  runIds: string[];
  costUsd?: number;
  redelivered?: true;
}

interface PendingNoticeData {
  v: 1;
  state: "pending";
  workflowId: string;
  at: number;
  content: string;
  details: WorkflowNotificationDetails;
  name: string;
  startedAt: number;
  outcome: WorkflowOutcome;
  usage?: BackgroundWorkflowUsage;
}
interface DeliveredNoticeData {
  v: 1;
  state: "delivered";
  workflowId: string;
  at: number;
}

type SendMessage = (
  message: { customType: string; content: string; display: boolean; details: unknown },
  options: { triggerTurn: boolean },
) => void;

export interface WorkflowNoticeSinkDeps {
  sendMessage: SendMessage;
  appendEntry: (customType: string, data: unknown) => void;
  emit?: (channel: string, payload: unknown) => void;
  usageOf?: (runId: string) => UsageDelta | undefined;
  resultMaxChars: () => number;
  now: () => number;
}

function buildNotice(
  settled: BackgroundWorkflowView & { outcome: WorkflowOutcome },
  usage: UsageDelta | undefined,
  maxChars: number,
): { content: string; details: WorkflowNotificationDetails } {
  const { outcome } = settled;
  return {
    content: formatWorkflowNotification(settled, usage, maxChars),
    details: {
      kind: "workflow",
      workflowId: settled.workflowId,
      label: settled.name,
      status: outcome.status,
      durationMs: outcome.durationMs,
      summary: formatWorkflowSummary(outcome, usage),
      runIds: liveChildRunIds(outcome),
      ...(usage ? { costUsd: usage.costUsd } : {}),
    },
  };
}

/** The `onSettled` hook for `createBackgroundWorkflows`: returns the aggregate usage it captured. */
export function createWorkflowNoticeSink(deps: WorkflowNoticeSinkDeps) {
  return (
    settled: BackgroundWorkflowView & { outcome: WorkflowOutcome },
    phase: BackgroundSettlePhase,
  ): BackgroundWorkflowUsage | undefined => {
    const usage = aggregateChildUsage(settled.outcome, deps.usageOf);
    const notice = buildNotice(settled, usage, deps.resultMaxChars());
    try {
      deps.emit?.(WORKFLOW_SETTLED_EVENT, { workflowId: settled.workflowId, status: settled.outcome.status });
    } catch {
      // bus listeners are best-effort
    }
    if (phase === "live") {
      try {
        deps.sendMessage(
          { customType: WORKFLOW_NOTIFICATION_TYPE, content: notice.content, display: true, details: notice.details },
          { triggerTurn: true },
        );
        return usage;
      } catch (error) {
        console.warn(
          `[pi-subagent] workflow ${settled.workflowId} notice send failed, persisting for re-delivery: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const data: PendingNoticeData = {
      v: 1,
      state: "pending",
      workflowId: settled.workflowId,
      at: deps.now(),
      content: notice.content,
      details: notice.details,
      name: settled.name,
      startedAt: settled.startedAt,
      outcome: settled.outcome,
      ...(usage ? { usage } : {}),
    };
    try {
      deps.appendEntry(WORKFLOW_NOTICE_ENTRY_TYPE, data);
    } catch (error) {
      console.warn(
        `[pi-subagent] workflow ${settled.workflowId} notice could not be persisted (lost): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return usage;
  };
}

function isNoticeData(value: unknown): value is PendingNoticeData | DeliveredNoticeData {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || typeof v.workflowId !== "string" || typeof v.at !== "number") return false;
  if (v.state === "delivered") return true;
  return (
    v.state === "pending" &&
    typeof v.content === "string" &&
    typeof v.name === "string" &&
    typeof v.startedAt === "number" &&
    v.outcome !== null &&
    typeof v.outcome === "object" &&
    v.details !== null &&
    typeof v.details === "object"
  );
}

/** Fold the branch's notice entries to the not-yet-delivered pending ones (newest first, TTL + count bounded). */
export function readPendingWorkflowNotices(branch: readonly unknown[], now: number): PendingNoticeData[] {
  const latest = new Map<string, PendingNoticeData | DeliveredNoticeData>();
  for (const raw of branch) {
    const entry = raw as { type?: string; customType?: string; data?: unknown };
    if (entry?.type !== "custom" || entry.customType !== WORKFLOW_NOTICE_ENTRY_TYPE) continue;
    if (!isNoticeData(entry.data)) continue;
    latest.set(entry.data.workflowId, entry.data);
  }
  return [...latest.values()]
    .filter((d): d is PendingNoticeData => d.state === "pending" && now - d.at <= PENDING_TTL_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_REDELIVER);
}

/**
 * Re-deliver pending notices left by the previous stack on this session file:
 * seed the registry (so get_subagent_result still answers for them), send the
 * message without triggering a turn, and append a `delivered` marker so the
 * next rebuild does not repeat it.
 */
export function redeliverPendingWorkflowNotices(deps: {
  branch: () => readonly unknown[];
  runs: Pick<BackgroundWorkflows, "seedTerminal">;
  sendMessage: SendMessage;
  appendEntry: (customType: string, data: unknown) => void;
  now: () => number;
}): number {
  let branch: readonly unknown[];
  try {
    branch = deps.branch();
  } catch {
    return 0;
  }
  let delivered = 0;
  for (const pending of readPendingWorkflowNotices(branch, deps.now())) {
    try {
      deps.runs.seedTerminal({
        workflowId: pending.workflowId,
        name: pending.name,
        startedAt: pending.startedAt,
        status: pending.outcome.status,
        outcome: pending.outcome,
        ...(pending.usage ? { usage: pending.usage } : {}),
      });
      deps.sendMessage(
        {
          customType: WORKFLOW_NOTIFICATION_TYPE,
          content: pending.content,
          display: true,
          details: { ...pending.details, redelivered: true },
        },
        { triggerTurn: false },
      );
      const marker: DeliveredNoticeData = { v: 1, state: "delivered", workflowId: pending.workflowId, at: deps.now() };
      deps.appendEntry(WORKFLOW_NOTICE_ENTRY_TYPE, marker);
      delivered++;
    } catch (error) {
      console.warn(
        `[pi-subagent] workflow ${pending.workflowId} notice re-delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return delivered;
}
