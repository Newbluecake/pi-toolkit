import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSize, getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveReserveTokens } from "./compact-hint/pi-settings.js";
import { DEFAULT_DYNAMIC_THRESHOLD_SETTINGS } from "./config/settings.js";
import {
  COMPACT_HINT_COOLDOWN_MS,
  COMPACT_HINT_CUSTOM_TYPE,
  USAGE_TICK_CUSTOM_TYPE,
  USAGE_TICK_HYSTERESIS_PERCENT,
  buildCompactForceText,
  buildCompactHintText,
  buildSwitchDemandText,
  buildSwitchHintText,
  buildUsageTickText,
  effectiveThresholdPercentWithTokens,
  isSwitchImminent,
  usageTickStep,
  windowScaledForcePercent,
} from "./compact-hint/threshold.js";
import { HYSTERESIS_PCT, resolveEffectiveHint } from "./compact-hint/dynamic/threshold.js";
import { hintNote, tickMarker } from "./compact-hint/dynamic/markers.js";
import { wireDynamicThreshold, type DynamicRuntime } from "./compact-hint/dynamic/wire.js";
import type { DynamicThresholdOutcome, ThresholdBasis } from "./compact-hint/dynamic/types.js";
import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { systemClock } from "./core/clock.js";
import { createBashJobManager, type BashJobManager } from "./bash/manager.js";
import { createJobStore } from "./bash/job-store.js";
import {
  adoptOrphans,
  handoffInProcess,
  migrateFlatRecords,
  reconcileRootDir,
  sanitizeSessionDirName,
  sweepHandoffRemnants,
} from "./bash/session-dirs.js";
import { createProcessPort } from "./bash/process.js";
import { previewCommand, type JobRecord } from "./bash/types.js";
import { describeJobStatus } from "./tools/bash-job-tool.js";
import { getChildBashRegistry, type HostRunView } from "./bash/child-registry.js";
import { dueAtFor, effectiveDeadlineAt } from "./core/deadline.js";
import { formatDuration } from "./ui/fleet-panel.js";
import { MemoryOutboxStore, MemoryRunStore } from "./core/store.js";
import type {
  DeadlineNotice,
  DeliveryPayload,
  RunId,
  SubagentExtensionPoints,
  WorktreeDisposal,
} from "./core/types.js";
import { probeReadBackEntries } from "./adapters/pi-compat.js";
import { mergeExtensionPoints } from "./extensions/registry.js";
import { createPiOutboxStore, OUTBOX_CUSTOM_TYPE } from "./adapters/pi-outbox-store.js";
import { detectPiCapabilities } from "./adapters/pi-compat.js";
import { createDeliveryEngine } from "./delivery/engine.js";
import { createFabricMailbox, type FabricPorts } from "./fabric/mailbox.js";
import { RESUME_TEXT } from "./tools/compact-tool.js";
import { createFabricRouter } from "./fabric/router.js";
import { createFabricThrottle } from "./fabric/throttle.js";
import { createFabricTree } from "./fabric/tree.js";
import { formatMessage, type FabricRecord } from "./core/message.js";
import { wrapWithRunLog } from "./adapters/pi-run-log.js";
import type { AgentTypeRegistry } from "./config/agent-types.js";
import {
  readScopedModels,
  recommendableModels,
  registryModelExists,
  type ModelLookupLike,
} from "./config/available-models.js";
import { resolveModelHint } from "./config/model-hint.js";
import type { AgentSettings } from "./config/settings.js";
import type { Runner } from "./service/ports.js";
import {
  createNotifier,
  deliveryKey,
  type Notifier,
  type PersistedDelivery,
  type DeliveryState,
} from "./delivery/notifier.js";
import {
  createContextReceiptTracker,
  runIdsFromNotificationDetails,
  type ContextReceiptTracker,
} from "./delivery/context-receipt.js";
import { createCoalescer, isCoalescible, type Coalescer } from "./delivery/coalescer.js";
import { formatDigest, formatSingle } from "./delivery/format.js";
import {
  deliveryOptionsFor,
  formatDeadlineNotice,
  formatWorkflowDeadlineNotice,
  overtimeTail,
  shouldDeliverDeadlineNotice,
  shouldDeliverWorkflowDeadlineNotice,
  TIMEOUT_NOTICE_TYPE,
  workflowDeliveryOptionsFor,
} from "./delivery/deadline-notice.js";
import { parseDeliveryKey } from "./core/delivery-key.js";
import {
  consultSessionDir,
  forkExpertSession,
  forkMainSessionSnapshot,
  FORK_TTL_MS,
  removeForkFile,
  resolveForkCwd,
  sweepForkDir,
} from "./consult/fork-store.js";
import { wireConsult, type ConsultWiring } from "./consult/index.js";
import type { ConsultForkStore } from "./consult/tool.js";
import type { MainSessionFacts } from "./consult/main-facts.js";
import { UsageBroadcaster } from "./delivery/usage-broadcast.js";
import { createCacheKeepaliveService, type CacheKeepaliveService } from "./service/cache-keepalive.js";
import {
  createCacheAdaptiveService,
  computeAdaptiveSignals,
  type CacheAdaptiveService,
} from "./service/cache-adaptive.js";
import { readBackAdaptiveSessionState } from "./cache-ttl/adaptive.js";
import { createQuotaStack, type QuotaHintState, type QuotaService, type QuotaStack } from "./quota/index.js";
import { readQuotaStatusTheme } from "./quota/render.js";
import { evaluateQuotaGate, parseSubscriptionProviders, quotaAnnotation, toLadderLevel } from "./quota/gate.js";
import { formatOutcomeSummary } from "./tools/agent-tool.js";
import { createMentionRegistry, type MentionRegistry } from "./mention/registry.js";
import { createMentionNotes, type MentionNotes } from "./mention/notes.js";
export type { MentionNotes };
import { EscalatingReaper, type OrphanRegistry } from "./runtime/reaper.js";
import { PiSessionDriver } from "./runtime/session-driver.js";
import { SingleSlotPool } from "./runtime/slot-pool.js";
import { EventWatchdog } from "./runtime/watchdog.js";
import { createRPCServer, type RPCServer } from "./rpc/server.js";
import { createScheduler, type Scheduler } from "./schedule/scheduler.js";
import { createQueryService, type QueryService } from "./service/query-service.js";
import { createLiveRunRegistry } from "./service/run-registry.js";
import { createRuntimeRunnerAdapter } from "./service/runtime-adapter.js";
import { createSpawnService, type SpawnService } from "./service/spawn-service.js";
import { registerDispositionSink, releaseDispositionSink } from "./adapters/worktree-disposition-sink.js";
import {
  isPidAlive,
  procStartOf,
  processStartedAt,
  runOrphanStartupScan,
  scanWorktreeOrphans,
  scanWorktreeOrphansAsync,
  trackedWorktrees,
  worktreeRoot,
  type WorktreeOrphanScanResult,
} from "./extensions/worktree-orphans.js";
import { FleetWidgetController } from "./ui/fleet-widget.js";
import { TODO_WIDGET_MOUNTED_EVENT } from "./ui/widget-mount-events.js";
import type { GoalSession, GoalSessionStartReason } from "./goal/state.js";
import { readBackGoalRecord } from "./goal/store.js";
import { buildResumeHintText, goalBadgeText } from "./goal/texts.js";
import { createWorkflowActivityRegistry, type WorkflowActivityRegistry } from "./workflow/activity.js";
import { createWorkerHost } from "./workflow/lifecycle.js";
import { createOrchestrator, type Orchestrator } from "./workflow/orchestrator.js";
import { buildWorkflowRunBudget } from "./workflow/run-budget.js";
import { createWorkflowChildSpawner } from "./workflow/spawner-adapter.js";
import { createBackgroundWorkflows, type BackgroundWorkflows } from "./workflow/background.js";
import { createWorkflowNoticeSink, redeliverPendingWorkflowNotices } from "./adapters/workflow-notice.js";
import type { WorkflowId, WorkflowRunBudget } from "./workflow/types.js";
import type { WorkflowDeadlineNotice } from "./workflow/deadline.js";

/** X7b: the previous session's fleet widget, disposed at the top of buildSessionStack.
 *  This module-level handoff only covers SAME-module session swaps (new/fork/resume):
 *  pi's /reload re-imports the extension as a fresh module (jiti moduleCache:false),
 *  leaving this undefined — that path is covered by session_shutdown disposing
 *  Stack.fleetWidget instead (see the Stack interface note). */
let previousFleetWidget: FleetWidgetController | undefined;
/** M-E: the previous session's usage broadcaster — same rebuild-dispose pattern as the fleet widget. */
let previousUsageBroadcaster: UsageBroadcaster | undefined;
let previousCoalescer: Coalescer | undefined;
let previousAckHold: Coalescer | undefined;
/**
 * bash auto-background §3.6: the previous session's job manager, disposed at
 * the top of the next build. `dispose()` only clears timers — it never kills a
 * process and never notifies afterwards, so the next stack's `recover()` can
 * adopt the still-running jobs and own the single notification channel.
 */
let previousBashJobs: BashJobManager | undefined;
/**
 * bash-timeout-grace plan §2.5 step 4/6 (P5): the previous stack's bash-job
 * recovery/cleanup dual-timer handle (see `scheduleBashJobRecovery` below),
 * disposed at the top of the next build — same dual-path discipline as
 * `previousBashJobs`/`previousFleetWidget` (the OTHER path is index.ts's
 * `session_shutdown` calling `Stack.bashJobRecovery.dispose()` directly).
 */
let previousBashJobRecovery: { dispose(): void } | undefined;
let previousFabricMailbox: ReturnType<typeof createFabricMailbox> | undefined;
/** cache-ttl keepalive (plan.md §2.2): same rebuild-dispose pattern as the usage broadcaster. */
let previousKeepalive: CacheKeepaliveService | undefined;
/** cache-ttl adaptive (adaptive plan.md §9): same rebuild-dispose pattern as the keepalive service. */
let previousAdaptive: CacheAdaptiveService | undefined;
/** quota（quota-plan §4.1）：与 keepalive/adaptive 同款「下一次 build 顶部 dispose」
 *  交接。`/reload` 走 session_shutdown dispose Stack.quota（M3：QuotaService.dispose
 *  是唯一清理所有者且幂等），与 previousFleetWidget 同一套双路径纪律。 */
let previousQuota: QuotaStack | undefined;
/** Background workflows (docs/dev/workflow-background/plan.md §4): the primary teardown is
 *  index.ts's session_shutdown (shutdown → drain → seal); this top-of-build handoff is the
 *  defensive path for a session_start without a paired shutdown — stop everything, report nothing. */
let previousWorkflowRuns: BackgroundWorkflows | undefined;
/**
 * workflow-worktree plan D13 (v2.1 condition 2): the previous stack's
 * spawn-service + runtime-adapter pair, disposed at the top of the next
 * build (same-module rebuild handoff, same dual-path discipline as
 * previousFleetWidget/previousQuota — the OTHER path is index.ts's
 * session_shutdown calling `Stack.worktreeLate.dispose()` directly, which
 * covers the `/reload` case where this module-level variable is reset to
 * undefined by the fresh re-import).
 */
let previousWorktreeLate: { dispose(): void } | undefined;
/**
 * workflow-worktree plan §3 (P4 fix, 2026 review): the previous stack's fire-and-forget
 * startup orphan scan "live" flag, disposed at the top of the next build — same dual-path
 * discipline as `previousWorktreeLate` (the OTHER path is index.ts's session_shutdown
 * calling `Stack.worktreeOrphansStartup.dispose()` directly). Flipping `live` to false
 * before the next build's own scan starts means a scan that is still resolving when the
 * stack gets rebuilt/torn down can NEVER fire a stale notify after the fact.
 */
let previousWorktreeOrphansStartup: { dispose(): void } | undefined;

/** customType of the bash job completion notice (§5) — distinct from `subagent:notification`. */
export const BASH_JOB_NOTIFICATION_TYPE = "bash-job:notification";
/** Output tail attached to a completion notice (§5). */
export const BASH_JOB_TAIL_BYTES = 1024;
export const BASH_JOB_TAIL_LINES = 10;
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

/** Wall-clock life of a job (spawn → exit, or → now while it runs). */
export function bashJobElapsedMs(record: JobRecord, now: number): number {
  return Math.max(0, (record.endedAt ?? now) - (record.spawnedAt ?? record.createdAt));
}

/** `exit N` when the code is known, otherwise the tool layer's own phrase. */
function bashJobOutcomePhrase(record: JobRecord): string {
  if ((record.status === "completed" || record.status === "failed") && record.exitCode !== null) {
    return `exit ${record.exitCode}`;
  }
  return describeJobStatus(record);
}

/**
 * §5 completion notice. Deliberately prefixed "Bash job" (vs. the
 * "Subagent …" wording of `delivery/format.ts`) so a downstream hook, the
 * user and the model can all tell the two notification channels apart.
 */
export function formatBashJobNotification(record: JobRecord, tail?: string, now: number = Date.now()): string {
  const head =
    `Bash job ${record.jobId} ($ ${previewCommand(record.command, 60)}) finished: ` +
    `${bashJobOutcomePhrase(record)} after ${formatDuration(bashJobElapsedMs(record, now))}.`;
  const body = tail !== undefined && tail.length > 0 ? ["--- output tail ---", tail, "---"] : [];
  return [
    head,
    ...body,
    `Full log: ${record.logPath} — a plain file: read it directly with the read tool, or with tail/grep/awk ` +
      `(grep a large log rather than reading it whole). Its last line records this outcome.`,
    ...(record.outputTruncated ? ["(the job's log hit its size cap; some output was dropped)"] : []),
  ].join("\n");
}

/**
 * bash-timeout-grace plan §4 (P5b): the main-session job-deadline notice
 * channel — distinct customType from the completion notice
 * (`BASH_JOB_NOTIFICATION_TYPE`) so a downstream hook/model can tell the two
 * apart. "grace" wakes the model into a decision turn (mirrors
 * `deliveryOptionsFor` for the run-level timeout-notify channel);
 * "extended" is a TUI-only receipt (the tool call already told the model the
 * same numbers in its own return text — §2.6/`bash-job-tool.ts`).
 */
export const BASH_JOB_DEADLINE_NOTIFICATION_TYPE = "bash-job:timeout";

/** §4/§2.6: the `extend_s` suggestion shown in the grace notice — same value as `bash-job-tool.ts`'s own grace line. */
const BASH_JOB_GRACE_SUGGESTED_EXTEND_S = 600;

/**
 * §4 main-session grace notice (seven-line template, mirrors
 * `delivery/deadline-notice.ts`'s run-level `formatDeadlineNotice`): wakes
 * the model with the job's own command/log context and a copyable `extend`
 * call. `record.deadline` is always defined when this is called (only
 * `onDeadline(record, "grace")` calls it) — the `undefined` branch is a
 * defensive fallback that should be unreachable.
 */
export function formatBashJobGraceNotice(record: JobRecord, now: number = Date.now()): string {
  const deadline = record.deadline;
  if (deadline === undefined) {
    return `⏳ Bash job ${record.jobId} hit its timeout and is STILL RUNNING.`;
  }
  const graceLeft = formatDuration(Math.max(0, (deadline.graceUntil ?? now) - now));
  const extensionsLeft = Math.max(0, deadline.policy.maxExtensions - deadline.extensions);
  const headroom = formatDuration(Math.max(0, deadline.hardAt - Math.max(now, deadline.dueAt)));
  return [
    `⏳ Bash job ${record.jobId} hit its ${formatDuration(deadline.timeoutMs)} timeout and is STILL RUNNING.`,
    `Grace: ${graceLeft} left — then it is killed as timed_out (partial log stays at ${record.logPath}).`,
    `Command: ${previewCommand(record.command, 60)} · running ${formatDuration(bashJobElapsedMs(record, now))} · log ${formatSize(record.logBytes)}`,
    `Give it more time:  bash_job(action: "extend", job_id: "${record.jobId}", extend_s: ${BASH_JOB_GRACE_SUGGESTED_EXTEND_S})`,
    `Budget left: ${extensionsLeft} of ${deadline.policy.maxExtensions} extensions, at most ${headroom} more.`,
    `Doing nothing lets it expire — that is a valid choice if you no longer need it.`,
  ].join("\n");
}

/**
 * §4 main-session "already extended" receipt — TUI-only (`triggerTurn:
 * false`): the tool's own return text (`bash-job-tool.ts`) already told the
 * calling model the same numbers, so this is display-only for the human
 * watching the session.
 */
export function formatBashJobExtendedNotice(record: JobRecord, now: number = Date.now()): string {
  const deadline = record.deadline;
  if (deadline === undefined) {
    return `⏳ Bash job ${record.jobId} timeout extended.`;
  }
  const extensionsLeft = Math.max(0, deadline.policy.maxExtensions - deadline.extensions);
  const headroom = formatDuration(Math.max(0, deadline.hardAt - Math.max(now, deadline.dueAt)));
  return (
    `⏳ Bash job ${record.jobId} timeout extended — now fires in ${formatDuration(Math.max(0, deadline.dueAt - now))} ` +
    `(${extensionsLeft} of ${deadline.policy.maxExtensions} extensions left, ${headroom} hard-limit headroom left).`
  );
}

function tailOffset(size: number): number {
  return Math.max(0, size - BASH_JOB_TAIL_BYTES);
}

export interface BashJobTail {
  readonly text: string | undefined;
  readonly logBytes: number;
}

function lastLines(content: string, max: number): string | undefined {
  const lines = content.replace(/\n+$/, "").split("\n");
  const tail = lines.slice(Math.max(0, lines.length - max)).join("\n");
  return tail.trim().length > 0 ? tail : undefined;
}

/**
 * Best-effort log tail for the notice. Never advances the model-facing read
 * cursor (`bash_job output` must still see everything) and never rejects — a
 * missing/unreadable log only costs the tail, not the notification.
 *
 * Two passes: a terminal record's `logBytes` is usually exact, but an adopted
 * or `exited_unknown` job's counter can lag behind the file, so the first read
 * (which reports the real size) is repeated from the true tail offset.
 */
export async function readBashJobTail(
  manager: BashJobManager,
  record: JobRecord,
  sizeHint?: number,
): Promise<BashJobTail | undefined> {
  try {
    const options = { advanceCursor: false, maxBytes: BASH_JOB_TAIL_BYTES } as const;
    // B1: record.logBytes may lag the adopted file, so the first bounded read
    // discovers the real size and the second pass re-reads the actual tail.
    const hintedSize = Math.max(record.logBytes, sizeHint ?? 0);
    let read = await manager.readOutput(record.jobId, { ...options, offset: tailOffset(hintedSize) });
    if (read.logBytes > hintedSize) {
      read = await manager.readOutput(record.jobId, { ...options, offset: tailOffset(read.logBytes) });
    }
    return { text: lastLines(read.content, BASH_JOB_TAIL_LINES), logBytes: read.logBytes };
  } catch {
    return undefined;
  }
}

function buildFabric(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settings: AgentSettings,
  prefetched: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
  readBack: boolean,
  runnerRef: { current?: Runner },
) {
  const store = readBack
    ? createPiOutboxStore<FabricRecord>(
        { appendEntry: pi.appendEntry, sessionManager: ctx.sessionManager },
        "subagent:fabric",
        prefetched,
      )
    : new MemoryOutboxStore<FabricRecord>();
  const allowed: Record<FabricRecord["state"], readonly FabricRecord["state"][]> = {
    pending: ["claimed", "consumed", "dropped", "abandoned"],
    claimed: ["pending", "delivered", "consumed", "dropped"],
    delivered: [],
    consumed: [],
    dropped: [],
    abandoned: [],
  };
  const engine = createDeliveryEngine<FabricRecord, FabricRecord["state"]>({
    store,
    allowed,
    memoryOnly: new Set(["claimed"]),
    memoryOnlyFields: ["claimToken"],
    now: () => systemClock.now(),
    onDegraded: (key, reason) => console.warn(`[pi-subagent] fabric persistence degraded for ${key}: ${reason}`),
  });
  const tree = createFabricTree();
  for (const entry of prefetched) {
    if (entry.type === "custom" && entry.customType === "subagent:run") {
      const snapshot = entry.data as { runId?: string; parentRunId?: string; status?: string } | undefined;
      if (snapshot?.runId) tree.appendEdge(snapshot.parentRunId ?? "root", snapshot.runId);
      if (snapshot?.runId && snapshot.status === "running") tree.markRunning(snapshot.runId);
      if (
        snapshot?.runId &&
        snapshot.status &&
        ["completed", "failed", "timed_out", "aborted"].includes(snapshot.status)
      )
        tree.tombstone(snapshot.runId, systemClock.now(), settings.reconcileTtlMs);
    }
  }
  const capabilities = detectPiCapabilities(pi);
  const throttle = createFabricThrottle({
    minIntervalMs: settings.fabric.minIntervalMs,
    rootMinIntervalMs: settings.fabric.rootMinIntervalMs,
    backoffMs: settings.deliveryBackoffMs,
    progressChannel: settings.fabric.progressChannel,
    canRenderEntries: capabilities.canRenderEntries,
    records: [...engine.select(() => true)],
  });
  const router = createFabricRouter(
    engine,
    tree,
    throttle,
    {
      ...settings.fabric,
      reconcileTtlMs: settings.reconcileTtlMs,
      canRenderEntries: capabilities.canRenderEntries,
    },
    () => systemClock.now(),
    () => mailbox.pump(),
  );
  router.hydrate([...engine.select(() => true)]);
  const ports: FabricPorts = {
    inject: async (record) => {
      const steer = runnerRef.current?.steer;
      if (!steer) throw new Error("fabric runner unavailable");
      const formatted = formatMessage(record, tree.relation(record.from, record.to, systemClock.now()));
      await steer(record.to as string, formatted.text);
      return { ok: true };
    },
    sendRootContext: async (record) => {
      pi.sendMessage(
        {
          customType: "subagent:fabric",
          content: formatMessage(record, "child").text,
          display: false,
          details: record,
        },
        { deliverAs: "steer", triggerTurn: true },
      );
      return { ok: true };
    },
    sendRootDisplay: async (record) => {
      // The entry renderer displays only state === "delivered" records (one
      // chat line per message despite the append-per-transition outbox). In
      // readBack mode the delivered store update appends that record; with
      // the degraded in-memory store it never reaches appendEntry, so stamp
      // this display-only append as delivered to keep it visible exactly once.
      pi.appendEntry(
        "subagent:fabric",
        readBack ? record : { ...record, state: "delivered" as const, deliveredAt: systemClock.now() },
      );
      return { ok: true };
    },
  };
  const mailbox = createFabricMailbox({
    engine,
    router,
    throttle,
    ports,
    clock: systemClock,
    fabricSteerTimeoutMs: settings.budget.steerMs,
    progressChannel: settings.fabric.progressChannel,
    canRenderEntries: capabilities.canRenderEntries,
    maxAttempts: settings.deliveryAttempts,
  });
  return { engine, tree, router, mailbox };
}

export function currentSessionId(ctx: ExtensionContext): string {
  try {
    return (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.() ?? "";
  } catch {
    return "";
  }
}

/**
 * consult (plan §16 "consult the main session"): live snapshot of the host
 * session's own persisted-session path / current model / current context
 * usage, read fresh on every call. Safe to call at any point in the
 * session's lifetime from the `ctx` captured once at `session_start` — the
 * same accessors `src/hud/footer.ts`'s `installFooter` already reads on
 * every later render from that very reference is the existing proof in this
 * codebase that this `ctx` stays live for the whole session rather than
 * freezing at capture time. Never throws (every failure degrades to `{}`,
 * mirroring every other `MainSessionFacts` producer).
 */
function mainSessionFactsFrom(ctx: ExtensionContext): MainSessionFacts {
  try {
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    const model = ctx.model;
    const usage = ctx.getContextUsage?.();
    return {
      ...(sessionFile !== undefined ? { sessionFile } : {}),
      ...(model !== undefined ? { model: { provider: model.provider, id: model.id } } : {}),
      ...(usage !== undefined ? { contextTokens: usage.tokens, contextPercent: usage.percent } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * bash auto-background §3/§5 assembly: store + process port + manager, with
 * the completion notice bound to `pi.sendMessage` (the manager itself has no
 * pi imports). A rejecting `notify` means "retry on the next poll", so
 * `notifiedAt` is only stamped once the message actually went out.
 */
function buildBashJobManager(pi: ExtensionAPI, ctx: ExtensionContext, settings: AgentSettings): BashJobManager {
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
      pi.sendMessage(
        {
          customType: BASH_JOB_NOTIFICATION_TYPE,
          content: formatBashJobNotification(record, tail?.text),
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

export interface WorkflowSupport {
  readonly enabled: boolean;
  readonly defaultBudget: WorkflowRunBudget;
  readonly activity: WorkflowActivityRegistry;
  readonly journalRootDir: string;
  /**
   * M3.6 (hand-off note, orchestrator.ts): one `Orchestrator` per workflow
   * run, not one per session — matching every `createOrchestrator(deps)`
   * call site in `tests/workflow/**` and the design's `OrchestratorDeps.
   * parentRunId` field (a single fixed value threaded into *every* spawned
   * child's `SpawnRequest.parentRunId` for that instance's whole lifetime,
   * §3.7's CC1 `stopChildrenOf` anchor). A shared session-lifetime instance
   * would have to pick one `parentRunId` for every workflow invocation in
   * the session, which breaks CC1's per-run cascade-stop anchoring the
   * instant two workflow runs are in flight at once. `workflowId` doubles as
   * that anchor (the same X3 pattern nested `Agent` delegation already uses).
   */
  createOrchestrator(workflowId: WorkflowId): Orchestrator;
  /**
   * Background SubagentWorkflow registry (docs/dev/workflow-background/plan.md):
   * running orchestrators + retained terminal outcomes, per session stack.
   */
  readonly runs: BackgroundWorkflows;
  /** Re-deliver notices a previous stack persisted during shutdown (called once from index.ts's session_start). */
  redeliverPendingNotices(): number;
}

export interface CompactHintState {
  thresholdPercent: number;
  /** Force line anchor. With `forceScaling` on this is the value for a 1M
   *  window and is scaled per decade against the real one; otherwise literal. */
  forceAtPercent: number;
  /** Scale `forceAtPercent` with the context window (default on). */
  forceScaling: boolean;
  /** Absolute thresholds in units of k tokens (0 = off); combined with the
   *  percent lines via min — whichever fires first wins. */
  thresholdTokens: number;
  forceAtTokens: number;
  reserveTokens: number;
  lastHintAt: number;
  /** hint 已发过的闩锁。`hintEpoch` 仅在 mode="on"（动态阈值，§9.2）时携带：高位期编号，
   *  真实用量跌破 line − 迟滞时由 runtime 自增并清空本字段（线自己动不重置提醒权）。 */
  hintedAt: { effectivePercent: number; contextWindow: number; hintEpoch?: number } | undefined;
  /** Coarsest step (percent points) between lightweight usage-tick reports;
   *  the grid densifies toward the force ceiling. 0 disables ticks. */
  tickStepPercent: number;
  /** Highest tick step already reported (0 = none). Re-armed downward only by
   *  a real drop larger than USAGE_TICK_HYSTERESIS_PERCENT (e.g. compaction),
   *  so boundary wobble never re-notifies. */
  lastTickStep: number;
  /** switch_context 模式（settings.compact.switchTool）：hint/force 层改为催模型自写交接。 */
  switchTool: boolean;
  /** 越线后先硬性要求切换的次数上限；用完仍越线才回落通用强制压缩。 */
  forceDemandTurns: number;
  /** 本轮高位期内已发出的硬性切换要求次数；用量回落到强制线以下即归零。 */
  demandCount: number;
  /** task #14：最近一次 turn_end 算出的生效线 + 交接暂存端口。「快要切换」在**请求时**由
   *  `isSwitchImminentNow` 用实时用量判定（压缩后 usage 未知 ⇒ false；turn_end 之后涨进余量区
   *  也能看到），cache-ttl 据此不再为即将丢弃的前缀付 1h 入场费。未算过（print/json、compact
   *  关）时 undefined ⇒ 恒 false。 */
  imminence: { hintPercent: number; forcePercent: number; handoffPending: (() => boolean) | undefined } | undefined;
  /** 价格感知动态阈值运行时（dynamic-threshold-plan.md D3）；mode=off / print、json 构造
   *  时缺席或惰性。与 `Stack.dynamic` 引用同一对象（§2.4 所有权在 Stack）。 */
  dynamic?: DynamicRuntime | undefined;
}

/** set_model (plan §4.10): single model-registry port shared by spawn admission,
 *  the injected run-form set_model tool, and the host-form tool (index.ts). */
export interface StackModelPort {
  resolveHint(hint: string): { provider: string; id: string } | undefined;
  find(provider: string, id: string): unknown | undefined;
  available(): readonly {
    provider: string;
    id: string;
    name?: string;
    reasoning?: boolean;
    contextWindow?: number;
  }[];
  /**
   * 推荐面（额度替代链）：会话 scope（`/models` 里激活的模型）∩ available；未配置
   * scope 时退化为 available。只用于「推荐」，解析/校验仍走 available。
   */
  recommendable(): readonly {
    provider: string;
    id: string;
    name?: string;
    reasoning?: boolean;
    contextWindow?: number;
  }[];
}

export interface Stack {
  compactHint: CompactHintState;
  /** 动态阈值运行时（compact-hint dynamic plan D3；mode=off 或 print/json 构造时缺席或惰性）。
   *  dispose 的接入点在 index.ts 的 session_shutdown / session_start 防御性清理（P1-4）。 */
  dynamic?: DynamicRuntime;
  /** Shared model-hint/registry port (spawn admission + set_model, plan §4.10). */
  models: StackModelPort;
  spawn: SpawnService;
  query: QueryService;
  orphans: OrphanRegistry;
  notifier: Notifier;
  contextReceipt: ContextReceiptTracker;
  mention: MentionRegistry;
  /** X6b: latest raw user @ message per run, shown in the fleet widget under the run. */
  mentionNotes: MentionNotes;
  scheduler: Scheduler;
  rpc: RPCServer;
  workflow: WorkflowSupport;
  /** X7b fleet widget; absent when settings.fleetWidget is off. Exposed so session_shutdown
   *  can dispose it: pi's /reload re-imports the extension as a FRESH module (jiti
   *  moduleCache:false), so the module-level previousFleetWidget handoff in
   *  buildSessionStack only covers same-module session swaps (new/fork/resume) — after a
   *  reload the old controller is unreachable module state, and since the stale ctx.ui
   *  closures keep working (no assertActive on setWidget), an undisposed controller's
   *  self-rescheduling 1Hz tick outlives its session FOREVER, pushing setWidget(undefined)
   *  over the new session's frames → the agent tree visibly blinks off/on. */
  fleetWidget?: FleetWidgetController;
  /** bash auto-background job manager; absent when the feature is off (§2.6/R6). */
  bashJobs?: BashJobManager;
  /**
   * bash-timeout-grace plan §2.5 step 4/6 (P5): this stack's recovery/cleanup
   * dual-timer handle (absent iff `bashJobs` itself is absent). `dispose()`
   * aborts whichever phase is still outstanding — called at the top of the
   * NEXT `buildSessionStack` (module-level handoff, above) AND by index.ts's
   * `session_shutdown` (covers the fresh-module `/reload` case).
   */
  bashJobRecovery?: { dispose(): void };
  fabric?: { dispose(): void; pump(): void };
  /** 提示词缓存保活调度器（plan.md §2）；settings.cacheTtl.keepalive=false 时缺席。 */
  keepalive?: CacheKeepaliveService;
  /** 自适应 1h TTL 决策器（adaptive plan.md §9）；settings.cacheTtl.adaptiveEnabled=false 时缺席。 */
  adaptive?: CacheAdaptiveService;
  /** 额度感知派单（docs/dev/quota/quota-plan.md）：同步缓存判定面。settings.quota.enabled=false 时缺席（R11）。 */
  quota?: QuotaService;
  /** turn_end 注入的会话级闩锁状态；与 quota 同生共死（M3：dispose 的唯一所有者是 QuotaService）。 */
  quotaHint?: QuotaHintState;
  /** /goal 目标驱动持续运行的 session 级运行态（goal-plan v4）。无持久 timer，纯数据。 */
  goal: GoalSession;
  /** consult (plan §6 D-14/D-16): always constructed (even with consult.enabled=false — the
   *  wiring itself degrades to no-op resolveExperts/depsFactory, matching the existing
   *  unconditional sweep). index.ts's top-level Agent tool forwards `resolveExperts` off this. */
  consult: ConsultWiring;
  /**
   * workflow-worktree plan D13 (v2.1 condition 2, frozen interface §4): tears down THIS
   * stack's spawn-service worktree waiters/timers and the runtime-adapter's live write-back
   * (redirecting any still-in-flight H3 report to the durable sink instead), and releases
   * this stack's disposition-sink registration. Idempotent. Called at the top of the NEXT
   * `buildSessionStack` (same-module rebuild handoff) AND by index.ts's session_shutdown
   * (covers `/reload`, which resets the module-level handoff variable).
   */
  worktreeLate?: { dispose(): void };
  /**
   * workflow-worktree plan §3 (P4 wt-orphans): live, read-only rescan (no caching) of the
   * worktree root for directories a dead/gone owner left behind — the data source for
   * `/agent status`'s `worktrees: N orphaned` line and for the once-per-process startup
   * notify fired inside `buildSessionStack`. Present unconditionally: scanning does NOT
   * depend on `worktree.enabled` (a leftover from before the feature was turned off is
   * still on disk and still needs cleaning — confirmed with the plan author). Bounded,
   * synchronous fs only, no exec, no writes/unlinks (non-goal: automatic GC, §0 decision 8).
   */
  worktreeOrphans(): WorktreeOrphanScanResult;
  /**
   * workflow-worktree plan §3 (P4 fix, 2026 review): dispose handle for the once-per-
   * process, fire-and-forget startup orphan scan started by THIS build. Flips the scan's
   * `live` flag off so a result that settles after this stack is rebuilt/torn down can never
   * fire a stale notify. Dual-path teardown — the top of the NEXT `buildSessionStack` disposes
   * the previous build's handle (same-module rebuild), and index.ts's `session_shutdown`
   * disposes it directly (covers `/reload`, which resets the module-level handoff variable).
   */
  worktreeOrphansStartup?: { dispose(): void };
}

/** Build the per-session L2/L3 stack (extracted from index.ts to keep it
 *  assembly-only, D7). Rebuilt on every session_start: ctx.sessionManager is
 *  only available there. */
/**
 * Production `message_start` → context-receipt hook. Lives here instead of
 * inline in index.ts so integration tests exercise the real filter +
 * forwarding path (customType literal, event shape) — index.ts stays
 * assembly-only (I7) and just registers this once per activate().
 */
/**
 * task #14: is the current prefix about to be discarded by a context switch? Evaluated at
 * request time against LIVE usage and the lines the last turn_end published, so it neither
 * lags a big tool result that landed after turn_end nor outlives a compaction (pi reports
 * usage as unknown until the first post-compaction response). A pending handoff counts
 * regardless of usage. Every failure degrades to `false` (the pre-#14 behaviour).
 */
export function isSwitchImminentNow(
  state: Pick<CompactHintState, "imminence">,
  ctx: Pick<ExtensionContext, "getContextUsage">,
): boolean {
  const imminence = state.imminence;
  if (imminence === undefined) return false;
  try {
    if (imminence.handoffPending?.() === true) return true;
    const percent = ctx.getContextUsage()?.percent;
    if (percent == null) return false;
    return isSwitchImminent(percent, imminence.hintPercent, imminence.forcePercent);
  } catch {
    return false;
  }
}

export function createCompactHintHook(
  holder: { current?: Stack },
  deps: {
    sendMessage: (
      // Visible by default (like subagent notifications): the user sees the
      // same message the model receives, persisted in the transcript.
      message: { customType: string; content: string; display: boolean; details: unknown },
      options: { triggerTurn: false },
    ) => void;
    now?: () => number;
    sendUserMessage?: (text: string) => void;
    /** switch_context 已暂存交接文本、压缩尚未完成 —— 此时既不再催，也不抢先强制压缩。 */
    handoffPending?: () => boolean;
  },
): (event: unknown, ctx: ExtensionContext) => void {
  const now = deps.now ?? (() => Date.now());
  let forcing = false;
  let lastForcedAt = 0;
  // §9.2「真实用量跌破」的方向坐标：上一轮观测到的 percent（unknown-usage 归零）。
  // 动态线上移越过静止/上潳的用量时不是「真实回落」，不得重置提醒权（设计意图：
  // 只有真实用量的回落才重置，任何「线自己动了」都不重置）。
  let lastPercentSeen: number | null = null;
  return (_event, ctx) => {
    if (ctx.mode === "print" || ctx.mode === "json") return;
    const state = holder.current?.compactHint;
    if (
      !state ||
      (state.thresholdPercent <= 0 &&
        state.forceAtPercent <= 0 &&
        state.thresholdTokens <= 0 &&
        state.forceAtTokens <= 0 &&
        state.tickStepPercent <= 0)
    )
      return;
    const usage = ctx.getContextUsage();
    const percent = usage?.percent;
    const debug = process.env.PI_SUBAGENT_DEBUG_COMPACT_HINT === "1";
    if (debug)
      console.warn(
        `[pi-subagent] compact-hint usage=${JSON.stringify(usage)} hintedAt=${JSON.stringify(state.hintedAt)}`,
      );
    if (!usage || percent == null) {
      state.hintedAt = undefined;
      lastPercentSeen = null;
      return;
    }
    const previousPercent = lastPercentSeen;
    lastPercentSeen = percent;
    // ── 动态阈值（dynamic-threshold-plan.md §3.6/§9.2/§10）：每轮 turn_end 重算一次（S1）。
    // 无 runtime（mode=off / compact 关）/ 惰性 / 内部禁用 ⇒ 合成与闩锁走原表达式
    //（mode=off 逐字节回滚保证，T-D3-OFF-GOLDEN）；shadow 只计算 + 遥测，不改模型可见字节。
    const activeRuntime = state.dynamic;
    let dyn: DynamicThresholdOutcome | undefined;
    if (activeRuntime !== undefined && activeRuntime.active) {
      try {
        dyn = activeRuntime.onTurnEnd({
          ctx, // 完整事件 ctx：mode（二次判惰性）+ sessionManager（§5.5 观察窗聚合）
          model: ctx.model,
          usage: { tokens: usage.tokens ?? null, percent, contextWindow: usage.contextWindow },
          staticHint: { percent: state.thresholdPercent, tokensK: state.thresholdTokens },
          force: {
            atPercent: state.forceAtPercent,
            atTokensK: state.forceAtTokens,
            forceScaling: state.forceScaling,
          },
          reserveTokens: state.reserveTokens,
        });
      } catch {
        dyn = undefined; // wire 内部已有 try/catch；这里再次兑底：遥测/动态层绝不拖垮主链路
      }
    }
    const runtimeOn =
      activeRuntime !== undefined && activeRuntime.active && activeRuntime.mode === "on" ? activeRuntime : undefined;
    const usableDyn = runtimeOn !== undefined && dyn?.usable === true ? dyn : undefined;
    // §3.6 合成（D3：min —— 动态线只能提前）。静态线更早 / 退化 / shadow / off ⇒ 原表达式不动。
    // 与 /agent status 共用 resolveEffectiveHint，保证 status 显示的生效线与真实触发点一致。
    const resolvedHint = resolveEffectiveHint({
      staticEffectivePercent: effectiveThresholdPercentWithTokens(
        state.thresholdPercent,
        state.thresholdTokens,
        usage.contextWindow,
        state.reserveTokens,
      ),
      staticLines: { percent: state.thresholdPercent, tokensK: state.thresholdTokens },
      window: usage.contextWindow,
      reserveTokens: state.reserveTokens,
      dynamic: usableDyn,
    });
    const effective = resolvedHint.percent;
    const dynamicLineWon = resolvedHint.dynamicWon;
    const effectiveForce = effectiveThresholdPercentWithTokens(
      state.forceScaling ? windowScaledForcePercent(state.forceAtPercent, usage.contextWindow) : state.forceAtPercent,
      state.forceAtTokens,
      usage.contextWindow,
      state.reserveTokens,
    );
    // task #14: publish the effective lines; cache-ttl judges imminence against live usage per request.
    state.imminence = { hintPercent: effective, forcePercent: effectiveForce, handoffPending: deps.handoffPending };
    if (effectiveForce > 0 && percent >= effectiveForce) {
      const timestamp = now();
      // switch_context 模式（先礼后兵）：越线先硬性要求模型自己写交接内容，
      // 只有它不照办（下一次 turn_end 仍越线）才回落到通用强制压缩——安全网不能拆。
      if (state.switchTool) {
        if (deps.handoffPending?.()) {
          if (debug) console.warn("[pi-subagent] compact-hint force skipped: handoff pending");
          return;
        }
        if (state.demandCount < state.forceDemandTurns) {
          state.demandCount += 1;
          if (debug)
            console.warn(
              `[pi-subagent] switch-context demand percent=${percent} force=${effectiveForce} attempt=${state.demandCount}`,
            );
          if (ctx.hasUI) {
            try {
              ctx.ui.notify(
                `Context ${Math.round(percent)}% ≥ ${effectiveForce}% — demanding switch_context`,
                "warning",
              );
            } catch {}
          }
          try {
            deps.sendMessage(
              {
                customType: COMPACT_HINT_CUSTOM_TYPE,
                content: buildSwitchDemandText(percent, effectiveForce),
                display: true,
                details: { percent, thresholdPercent: effectiveForce, demand: true, attempt: state.demandCount },
              },
              { triggerTurn: false },
            );
            // §5.4：demand 发出 ⇒ 建立 forceMarker（发送失败则不建，不留脏归因）。
            activeRuntime?.noteForce("demand");
          } catch (error) {
            console.warn(`[pi-subagent] switch-context demand send failed: ${String(error)}`);
          }
          return;
        }
      }
      if (forcing || (lastForcedAt > 0 && timestamp - lastForcedAt < COMPACT_HINT_COOLDOWN_MS)) {
        if (debug) console.warn(`[pi-subagent] compact-hint force skipped: ${forcing ? "in-flight" : "cooldown"}`);
        return;
      }
      forcing = true;
      lastForcedAt = timestamp;
      state.demandCount = 0;
      if (debug)
        console.warn(`[pi-subagent] compact-hint force triggered percent=${percent} effective=${effectiveForce}`);
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(`Context ${Math.round(percent)}% ≥ ${effectiveForce}% — forcing compaction`, "warning");
        } catch {}
      }
      try {
        deps.sendMessage(
          {
            customType: COMPACT_HINT_CUSTOM_TYPE,
            content: buildCompactForceText(percent, effectiveForce),
            display: true,
            details: { percent, thresholdPercent: effectiveForce, forced: true },
          },
          { triggerTurn: false },
        );
        // §5.4：force 压缩已发起 ⇒ 建立 forceMarker；成败由 session_compact / onError /
        // 同步 catch / session_compact_failed 四条路径归宿（R2-4）。
        activeRuntime?.noteForce("force");
      } catch (error) {
        console.warn(`[pi-subagent] compact-hint force notice send failed: ${String(error)}`);
      }
      try {
        ctx.compact({
          onComplete: () => {
            forcing = false;
            try {
              deps.sendUserMessage?.(RESUME_TEXT);
            } catch {}
          },
          onError: (error) => {
            forcing = false;
            activeRuntime?.clearForceMarker(); // §5.4 清除②：ctx.compact() 失败立即清
            if (debug) console.warn(`[pi-subagent] compact-hint force failed: ${error.message}`);
          },
        });
      } catch (error) {
        forcing = false;
        activeRuntime?.clearForceMarker(); // §5.4 清除②：同步抛出同样立即清
        if (debug) console.warn(`[pi-subagent] compact-hint force failed synchronously: ${String(error)}`);
      }
      return;
    }
    // Usage ticks: lightweight stepped reports at every step so the model
    // stays aware of context usage across the whole range — including the L1
    // hint zone (the hint fires only once, ticks keep the visibility alive);
    // the force zone (L2) owns the range at/above its ceiling. The grid is
    // non-linear: it densifies as usage approaches the ceiling, so reminders
    // get more frequent exactly where acting on them matters. Latched per
    // step; re-armed only by a real drop larger than the hysteresis (e.g.
    // compaction), never by boundary wobble.
    const tickCeiling = effectiveForce > 0 ? effectiveForce : 100;
    // 回到强制线以下：硬性切换要求的计数归零（下次越线重新先礼后兵）。
    state.demandCount = 0;
    const tick = usageTickStep(percent, state.tickStepPercent, tickCeiling);
    if (tick < state.lastTickStep && percent <= state.lastTickStep - USAGE_TICK_HYSTERESIS_PERCENT) {
      state.lastTickStep = tick;
    }
    // §10.1：tick 尾部的英文短标记（仅 mode=on 且有 hint 线；省略 ⇒ 文案与今天逐字节相同）。
    const tickMarkerText =
      runtimeOn !== undefined && effective > 0
        ? tickMarker(
            dynamicLineWon && usableDyn !== undefined ? usableDyn.basis : "static",
            effective,
            usableDyn?.nextTierTokens,
          )
        : undefined;
    const trySendTick = () => {
      if (tick <= state.lastTickStep) return;
      try {
        deps.sendMessage(
          {
            customType: USAGE_TICK_CUSTOM_TYPE,
            content: buildUsageTickText(
              percent,
              effective > 0 ? effective : 0,
              state.switchTool ? "switch_context" : "compact_context",
              tickMarkerText,
            ),
            display: true,
            details: { percent, tickStep: tick },
          },
          { triggerTurn: false },
        );
        state.lastTickStep = tick;
        if (debug) console.warn(`[pi-subagent] usage-tick sent percent=${percent} step=${tick} ceiling=${tickCeiling}`);
      } catch (error) {
        console.warn(`[pi-subagent] usage-tick send failed: ${String(error)}`);
      }
    };
    // §9.2 闩锁：mode=on ⇒ epoch 闩锁（线自己动不重置提醒权；只有真实用量跌破
    // line − 迟滞才重置）；其余模式 ⇒ 与今天逐字节等价的表达式。
    if (effective <= 0 || percent < effective) {
      if (runtimeOn !== undefined) {
        // 真实回落（跌破 line − 迟滞 **且用量确实在下降**）才重置提醒权；
        // 动态线上移越过静止的用量不算（「线自己动了」不重置，§9.2 设计意图）。
        if (
          effective > 0 &&
          percent < effective - HYSTERESIS_PCT &&
          previousPercent !== null &&
          percent < previousPercent
        ) {
          runtimeOn.noteRealDrop();
          state.hintedAt = undefined;
        }
      } else {
        state.hintedAt = undefined;
      }
      trySendTick();
      return;
    }
    const latched =
      runtimeOn !== undefined
        ? state.hintedAt?.hintEpoch !== undefined && state.hintedAt.hintEpoch === runtimeOn.hintEpoch()
        : state.hintedAt?.effectivePercent === effective && state.hintedAt.contextWindow === usage.contextWindow;
    // §6.3 跨档前一次性提醒：允许突破 hint 的冷却发一次（每个 B 一张票；P1-9：B 本身仍属低价档）。
    const tierTicket =
      runtimeOn !== undefined && usableDyn !== undefined && runtimeOn.consumeTierTicket(usage.tokens ?? null);
    if (latched && !tierTicket) {
      trySendTick();
      return;
    }
    const timestamp = now();
    if (!tierTicket && state.lastHintAt > 0 && timestamp - state.lastHintAt < COMPACT_HINT_COOLDOWN_MS) {
      trySendTick();
      return;
    }
    // §10.2：动态线的中文单行说明。仅当动态线真正生效（dynamicLineWon）或跨档票
    // 命中时附加——静态线独占时阈值并非价格模型给出，不能冒充；demand（L2）不加。
    let note: string | undefined;
    if (usableDyn !== undefined && (dynamicLineWon || tierTicket)) {
      const noteBasis: ThresholdBasis = tierTicket ? "tier" : usableDyn.basis;
      note = hintNote(noteBasis, {
        hintPercent: effective,
        usedTokens: usage.tokens ?? null,
        window: usage.contextWindow,
        nextTierTokens: usableDyn.nextTierTokens,
        ...(usableDyn.subscriptionPressure !== undefined ? { usedPct: usableDyn.subscriptionPressure } : {}),
      });
    }
    try {
      deps.sendMessage(
        {
          customType: COMPACT_HINT_CUSTOM_TYPE,
          content: state.switchTool
            ? buildSwitchHintText(percent, effective, effectiveForce, note)
            : buildCompactHintText(percent, effective, effectiveForce, note),
          display: true,
          details: { percent, thresholdPercent: effective },
        },
        { triggerTurn: false },
      );
    } catch (error) {
      console.warn(`[pi-subagent] compact-hint send failed: ${String(error)}`);
      return;
    }
    state.hintedAt =
      runtimeOn !== undefined
        ? { effectivePercent: effective, contextWindow: usage.contextWindow, hintEpoch: runtimeOn.hintEpoch() }
        : { effectivePercent: effective, contextWindow: usage.contextWindow };
    state.lastHintAt = timestamp;
    // The hint already reports the current percent — absorb any pending tick
    // step so we don't double-inject usage info in the same turn.
    if (tick > state.lastTickStep) state.lastTickStep = tick;
    if (debug)
      console.warn(
        `[pi-subagent] compact-hint sent percent=${percent} effective=${effective} contextWindow=${usage.contextWindow}`,
      );
    if (ctx.hasUI) {
      try {
        ctx.ui.notify(`Context ${Math.round(percent)}% ≥ ${effective}% — hinted model to compact`, "info");
      } catch {
        // UI notification is best effort.
      }
    }
  };
}

export function createNotificationReceiptHook(holder: {
  current?: Stack;
}): (event: { message: { role?: string; customType?: string; details?: unknown } }) => void {
  return (event) => {
    const message = event.message;
    if (message.role !== "custom" || message.customType !== "subagent:notification") return;
    holder.current?.contextReceipt.noteEntered(runIdsFromNotificationDetails(message.details), Date.now());
  };
}

/**
 * quota-plan §4.1：HUD status key `"quota"`（与 `cache-ttl`/`goal` 并列分槽，
 * integration-map §8）。逐字照抄 cache-keepalive 的 safeSetStatus：try/catch +
 * `ctx.ui.setStatus` 双探测——陈旧 ctx / print 模式下静默（R8）。
 */
function safeSetQuotaStatus(ctx: ExtensionContext, text: string | undefined): void {
  try {
    if (ctx.ui && typeof ctx.ui.setStatus === "function") ctx.ui.setStatus("quota", text);
  } catch {
    // ui not ready / stale ctx — never let visibility break the feature (R8).
  }
}

export function buildSessionStack(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settings: AgentSettings,
  types: AgentTypeRegistry,
  mergedExtensions: readonly SubagentExtensionPoints[],
  /** /goal 读回口径（v4 条件 8）需要 session_start 的 reason；默认 "reload"（静默读回）。 */
  sessionReason: GoalSessionStartReason = "reload",
): Stack {
  // X7b: session rebuild — dispose the previous session's fleet widget
  // (stop its tick + setWidget(key, undefined)) before the new one mounts.
  previousFleetWidget?.dispose();
  previousFleetWidget = undefined;
  previousUsageBroadcaster?.dispose();
  previousUsageBroadcaster = undefined;
  previousCoalescer?.dispose();
  previousCoalescer = undefined;
  previousAckHold?.dispose();
  previousAckHold = undefined;
  // §3.6/§3.7: capture before dispose so in-process jobs can transfer their
  // live LocalHandle to the new manager; dispose keeps those handles alive.
  const prevBashJobs = previousBashJobs;
  prevBashJobs?.dispose();
  previousBashJobs = undefined;
  // bash-timeout-grace plan §2.5 step 4/6 (P5): abort whichever of the
  // previous stack's recovery/cleanup phases is still outstanding.
  previousBashJobRecovery?.dispose();
  previousBashJobRecovery = undefined;
  previousFabricMailbox?.dispose();
  previousFabricMailbox = undefined;
  previousKeepalive?.dispose();
  previousKeepalive = undefined;
  previousAdaptive?.dispose();
  previousAdaptive = undefined;
  previousQuota?.dispose();
  previousQuota = undefined;
  previousWorkflowRuns?.abandon();
  previousWorkflowRuns = undefined;
  previousWorktreeLate?.dispose();
  previousWorktreeLate = undefined;
  previousWorktreeOrphansStartup?.dispose();
  previousWorktreeOrphansStartup = undefined;

  // consult (plan §5.1/§6 C-9): fork-copy GC — once per session build, no
  // timer. Unconditional (runs even with consult.enabled=false so leftovers
  // from before a disable still age out). Multi-process safety argument and
  // the two load-bearing premises live with sweepForkDir: ① any live consult
  // run dies within its 150s totalMs hard cap, so an in-use fork file is
  // ~576× younger than the 24h TTL; ② the "no valid header ⇒ delete
  // regardless of mtime" fragment rule cannot hit a file mid-creation because
  // the fork's very first write is a complete header line (header-first
  // write order). Never throws; missing dir is a no-op.
  sweepForkDir(consultSessionDir(), FORK_TTL_MS);

  // The widget controller is created after QueryService exists (below), but
  // its H1 onLifecycle must be part of the merged extension points *before*
  // the runner is built — hence a late-bound ref (same pattern as spawnRef).
  const contextReceipt = createContextReceiptTracker();
  const compactHint: CompactHintState = {
    thresholdPercent: settings.compact.enabled ? settings.compact.hintThresholdPercent : 0,
    forceAtPercent: settings.compact.enabled ? settings.compact.forceAtPercent : 0,
    forceScaling: settings.compact.forceScaling,
    thresholdTokens: settings.compact.enabled ? settings.compact.hintThresholdTokens : 0,
    forceAtTokens: settings.compact.enabled ? settings.compact.forceAtTokens : 0,
    reserveTokens: resolveReserveTokens(settings.compact.assumedReserveTokens, ctx.cwd),
    lastHintAt: 0,
    hintedAt: undefined,
    tickStepPercent: settings.compact.enabled ? settings.compact.usageTickStepPercent : 0,
    lastTickStep: 0,
    switchTool: settings.compact.enabled && settings.compact.switchTool,
    forceDemandTurns: settings.compact.forceDemandTurns,
    demandCount: 0,
    imminence: undefined,
  };
  const widgetRef: { current?: FleetWidgetController } = {};
  // quota-plan D2: lifecycle-triggered refreshes stay lazy and reuse the
  // service's per-provider TTL/in-flight guards (main session only).
  const quotaRef: { current?: QuotaStack | undefined } = {};
  const quotaLifecyclePoints: SubagentExtensionPoints = {
    onLifecycle: (event) => {
      if (
        event.status === "running" ||
        event.status === "completed" ||
        event.status === "failed" ||
        event.status === "timed_out" ||
        event.status === "aborted"
      ) {
        quotaRef.current?.service.refreshIfStale();
      }
    },
  };
  const widgetPoints: SubagentExtensionPoints = { onLifecycle: () => widgetRef.current?.refresh() };
  const receiptPoints: SubagentExtensionPoints = {
    onDelivery: (payload, state) =>
      contextReceipt.noteDelivery(payload.runId, payload.generation, state as DeliveryState, systemClock.now()),
  };
  // M-E: real-time cost broadcast — poked on run start (onSnapshot below) and
  // every lifecycle event so the final terminal frame is always emitted.
  const usageRef: { current?: UsageBroadcaster } = {};
  const usagePoints: SubagentExtensionPoints = { onLifecycle: () => usageRef.current?.poke() };
  const merged = mergeExtensionPoints([
    ...mergedExtensions,
    widgetPoints,
    usagePoints,
    receiptPoints,
    quotaLifecyclePoints,
  ]);

  // G5a degradation: ctx.sessionManager is part of pi's session ctx contract
  // (types.d.ts:219), but if a future pi drops it we degrade to in-memory
  // stores + WARN instead of throwing inside the session_start handler.
  const readBack = probeReadBackEntries(ctx);
  const prefetchedEntries = readBack ? ctx.sessionManager.getEntries() : [];
  // Rehydrate only notifications on the current branch. A missing read-back probe
  // deliberately skips seeding because the session history cannot be trusted then.
  if (readBack) {
    const branch = (ctx.sessionManager as { getBranch?: () => readonly unknown[] }).getBranch?.() ?? [];
    for (const entry of branch) {
      const candidate = entry as { type?: string; customType?: string; details?: unknown };
      if (candidate.type === "custom_message" && candidate.customType === "subagent:notification") {
        const at = Date.parse((entry as { timestamp?: string }).timestamp ?? "");
        if (Number.isFinite(at)) contextReceipt.noteEntered(runIdsFromNotificationDetails(candidate.details), at);
      }
    }
  }
  if (!readBack)
    console.warn(
      "[pi-subagent] ctx.sessionManager.getEntries unavailable; run-log/outbox degrade to in-memory (G5a read-back verification off).",
    );
  const runLogHost = { appendEntry: pi.appendEntry, sessionManager: ctx.sessionManager };
  const store = readBack ? wrapWithRunLog(new MemoryRunStore(), runLogHost) : new MemoryRunStore();
  const pool = new SingleSlotPool(systemClock, settings.concurrencyLimit);
  const reaper = new EscalatingReaper(systemClock);
  // M4: watchdog 不再是空壳——通过 runnerRef 晚绑定到真实 runner（watchdog 先于
  // runner 构造，与 spawnRef 同一模式）。此前 getState/dispatch 都是 no-op，
  // 所有子阶段超时（idle/firstEvent/tool/…）从不触发，唯一生效的只有 runner
  // 内部 guard 的 totalMs——上游慢速涓流时 run 会一路挂到总预算（事故复盘见
  // CHANGELOG）。tick 只派发 deadline_fired，其他 input 类型不会出现。
  const runnerRef: { current?: Runner } = {};
  const watchdog = new EventWatchdog({
    clock: systemClock,
    budget: settings.budget,
    getState: (runId, gen) => runnerRef.current?.getRunState?.(runId, gen),
    dispatch: (runId, gen, input) => {
      if (input.kind === "deadline_fired") runnerRef.current?.fireDeadline?.(runId, gen, input);
    },
  });
  const outbox = readBack
    ? createPiOutboxStore(
        { appendEntry: pi.appendEntry, sessionManager: ctx.sessionManager },
        OUTBOX_CUSTOM_TYPE,
        prefetchedEntries,
      )
    : new MemoryOutboxStore<PersistedDelivery>();
  let taken = new Set<string>();
  try {
    taken = new Set(
      outbox
        .list()
        .map((r) => parseDeliveryKey(r.key)?.runId)
        .filter((id): id is string => id !== undefined),
    );
  } catch {
    console.warn("[pi-subagent] outbox list failed; runId uniqueness degrades to process-local (M17)");
  }
  const spawnRef: { current?: SpawnService } = {};
  // quota-plan §4.1 / integration-map §7：spawn 闸门（下方 createSpawnService）
  // 需要 quota，而 quota 按计划构造在 keepalive/adaptive 之后——晚绑定 ref
  // 解决「A 需要还没构造出来的 B」（runnerRef/widgetRef 同款）。
  const mention = createMentionRegistry();
  // X6b: session-scoped, capped FIFO — notes are one-line previews, never read
  // back into context. Pending (steer-path) notes self-clear once the target run
  // starts a fresh model turn past the recorded baseline (see mention/notes.ts).
  // diagOf MUST go through the live run registry (query.get): persist_snapshot
  // is a terminal-only effect (I4), so store.get never sees in-flight diag
  // updates — a store-backed diagOf freezes lastTurnStartAt/lastEventAt at
  // enqueue time and pending notes would never clear.
  let query: QueryService;
  const mentionNotes = createMentionNotes({ diagOf: (runId) => query.get(runId)?.diag });
  const mentionRef = { current: mention };
  const fabric = settings.fabric.enabled
    ? buildFabric(pi, ctx, settings, prefetchedEntries, readBack, runnerRef)
    : undefined;
  if (fabric) previousFabricMailbox = fabric.mailbox;
  const sendFormatted = (items: readonly DeliveryPayload[]) => {
    const stats = Object.fromEntries(
      items.flatMap((item) => {
        const outcome = store.get(item.runId)?.outcome;
        return outcome ? [[item.key, formatOutcomeSummary(outcome)]] : [];
      }),
    );
    if (items.length === 1) {
      const payload = items[0]!;
      const snapshot = store.get(payload.runId);
      const outcome = snapshot?.outcome;
      const fallbackReason =
        payload.status !== "completed"
          ? (outcome?.error?.message ?? outcome?.timeoutReason ?? snapshot?.diag.error?.message)
          : undefined;
      const presented = {
        ...payload,
        ...(payload.label === undefined && snapshot?.diag.label !== undefined ? { label: snapshot.diag.label } : {}),
        ...(payload.failReason === undefined && fallbackReason !== undefined ? { failReason: fallbackReason } : {}),
      };
      const singleStats = stats[payload.key];
      // timeout-notify：完成文案带宽限/延长审计尾巴（无 overtime 时为空串）。
      const tail = payload.status === "completed" ? overtimeTail(snapshot?.diag) : "";
      pi.sendMessage(
        {
          customType: "subagent:notification",
          content: formatSingle(presented, singleStats !== undefined ? { stats: singleStats } : undefined) + tail,
          display: true,
          details: payload,
        },
        { triggerTurn: true },
      );
      return;
    }
    // Digest details are discriminated by kind. Consumers must inspect kind first and read items.
    const first = items[0]!;
    pi.sendMessage(
      {
        customType: "subagent:notification",
        content: formatDigest(items, { stats }),
        display: true,
        details: { ...first, kind: "digest", items },
      },
      { triggerTurn: true },
    );
  };
  /**
   * timeout-notify（arch §5.2）：宽限/延长通知的独立通道——customType 是
   * "subagent:timeout"（不进 outbox、不占 delivery key、不被 receipt hook 记账，
   * D-4/P10 保持不变），经 pi.sendMessage 直注主会话上下文。投递策略由
   * shouldDeliverDeadlineNotice 判定（settings.extend.notify + caller-ack 抑制）。
   */
  const sendDeadlineNotice = (notice: DeadlineNotice) => {
    if (
      !shouldDeliverDeadlineNotice(notice, {
        policy: settings.extend.notify,
        expectsAck: (id) => spawnRef.current?.expectsAck(id) === true,
      })
    )
      return;
    const snapshot = query.get(notice.runId);
    pi.sendMessage(
      {
        customType: TIMEOUT_NOTICE_TYPE,
        content: formatDeadlineNotice(notice, {
          now: systemClock.now(),
          ...(snapshot === undefined ? {} : { snapshot }),
        }),
        display: true,
        details: notice,
      },
      deliveryOptionsFor(notice),
    );
  };
  let notifier: Notifier;
  const coalescer =
    settings.coalesceWindowMs > 0
      ? createCoalescer({
          clock: systemClock,
          windowMs: settings.coalesceWindowMs,
          maxBatch: settings.coalesceMaxBatch,
          send: sendFormatted,
          onSettled: (keys, ok) => notifier.settleBatch(keys, ok),
        })
      : undefined;
  const isAckHoldable = (payload: DeliveryPayload) =>
    isCoalescible(payload) && spawnRef.current?.expectsAck(payload.runId) === true;
  const ackHold =
    settings.ackWindowMs > 0
      ? createCoalescer({
          clock: systemClock,
          windowMs: settings.ackWindowMs,
          maxBatch: settings.coalesceMaxBatch,
          send: (items) => items.forEach((item) => sendFormatted([item])),
          onSettled: (keys, ok) => notifier.settleBatch(keys, ok),
        })
      : undefined;
  notifier = createNotifier({
    store: outbox,
    clock: systemClock,
    maxAttempts: settings.deliveryAttempts,
    backoffMs: settings.deliveryBackoffMs,
    reconcileTtlMs: settings.reconcileTtlMs,
    maxReconcileRounds: settings.maxReconcileRounds,
    maxBatch: settings.maxReconcileBatch,
    ...(merged.onDelivery ? { onDelivery: merged.onDelivery } : {}),
    cancelBuffered: (key) => {
      coalescer?.cancel(key);
      ackHold?.cancel(key);
    },
    sender: {
      willBuffer: (payload) =>
        (coalescer !== undefined && isCoalescible(payload)) || (ackHold !== undefined && isAckHoldable(payload)),
      sendMessage: (payload) => {
        if (coalescer && isCoalescible(payload)) return coalescer.submit(payload);
        if (ackHold && isAckHoldable(payload)) return ackHold.submit(payload);
        sendFormatted([payload]);
      },
    },
  });
  previousCoalescer = coalescer;
  previousAckHold = ackHold;
  // X3: lazy ref — nested Agent tool + abort-cascade need SpawnService, built just below.
  // M-D: runIds whose "subagent:started" event has already been emitted (once per run).
  const announcedStarts = new Set<string>();
  // Fuzzy model hints (frontmatter `model: sonnet`, Agent tool `model: "kimi-k3"`,
  // set_model) resolve against pi's available models — getAvailable() already
  // filters to authenticated/usable entries, so a hint can never land on a
  // model the session couldn't actually run. One port, three consumers:
  // spawn admission, the per-run injected set_model tool, the host tool.
  const availableEntries = (): {
    provider: string;
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
  }[] =>
    ctx.modelRegistry.getAvailable().map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
    }));
  const models: StackModelPort = {
    resolveHint: (hint) =>
      resolveModelHint(
        hint,
        ctx.modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id, name: m.name })),
      ),
    find: (p, id) => ctx.modelRegistry.find(p, id),
    available: availableEntries,
    recommendable: () => {
      // scopedModels 是 live getter（用户中途改 /models scope 立即生效）；会话被替换后
      // assertActive 会抛——推荐面降级为 available，绝不拖垮 turn_end / spawn。
      let scoped: ReturnType<typeof readScopedModels> = [];
      try {
        scoped = readScopedModels(ctx.scopedModels);
      } catch {
        scoped = [];
      }
      return recommendableModels(scoped, availableEntries());
    },
  };
  // X1 (agent tree): late-bound holder — the adapter is created below but
  // spawn-service (whose live records the worktree marker must reach) only
  // exists afterwards; filled in right after createSpawnService, same
  // ref-holder pattern as spawnRef/nestedSpawn.
  const worktreeDiag: { current?: (runId: RunId, disposition: WorktreeDisposal) => void } = {};
  // consult (plan §6 D-14): same lazy-ref pattern as worktreeDiag/nestedSpawn —
  // wireConsult itself needs the live SpawnService + QueryService, both of
  // which are only constructed after this runner, so the adapter deps below
  // are indirections through this ref, filled in once wireConsult runs.
  const consultRef: { current?: ConsultWiring } = {};
  // bash-timeout-grace plan §3.1-3.3 (P5): the process-global registry the
  // child (subagent) session's own bash job manager registers into
  // (src/bash/child.ts). `query` is referenced by closures below that only
  // ever run later (async, once a real run exists) — by then it holds the
  // value assigned further down in this same function (same forward-
  // reference pattern as spawnRef/consultRef above).
  const childBashRegistry = getChildBashRegistry();
  const pendingToolReturns = new Map<string, number>();
  const warnedToolLag = new Set<string>();
  const hostViewFor = (runId: RunId): HostRunView => ({
    runId,
    watchdogDueAt: () => {
      const snapshot = query.get(runId);
      if (!snapshot) return undefined;
      const dueAt = dueAtFor(snapshot.phase, snapshot.diag, settings.budget);
      const effAt = effectiveDeadlineAt(snapshot.deadlines);
      if (dueAt === undefined) return effAt;
      if (effAt === undefined) return dueAt;
      return Math.min(dueAt, effAt);
    },
    hardDeadlineAt: () => query.get(runId)?.deadlines.hardDeadlineAt,
    maxExtensions: () => settings.budget.maxExtensions,
    stopping: () => query.get(runId)?.status === "stopping",
    noteToolReturn: (toolCallId, at) => {
      // §3.6 boundary telemetry — bounded the same way as every other
      // bookkeeping map in this codebase (a stuck/never-returning tool call
      // must not pin this map forever).
      if (pendingToolReturns.size >= 256) {
        const oldest = pendingToolReturns.keys().next();
        if (!oldest.done) pendingToolReturns.delete(oldest.value);
      }
      pendingToolReturns.set(toolCallId, at);
    },
  });
  const runner = createRuntimeRunnerAdapter({
    clock: systemClock,
    driver: new PiSessionDriver(settings.rememberAgents, (p, id) => ctx.modelRegistry.find(p, id)),
    pool,
    store,
    watchdog,
    reaper,
    notifier,
    ...(fabric
      ? {
          fabric: {
            router: fabric.router,
            mention: { registry: mention, query: () => query, spawn: () => spawnRef.current },
          },
        }
      : {}),
    extensions: [merged],
    onLifecycle: (event) =>
      pi.events.emit(event.status === "completed" ? "subagent:completed" : "subagent:failed", event),
    nestedSpawn: () => spawnRef.current,
    resultMaxChars: () => settings.resultMaxChars,
    // L1 (agent-tool pool-full plan §2): forwarded to the nested Agent tool's
    // `queueWhenFull` dep, read fresh so a live /agent settings edit applies
    // immediately (same convention as resultMaxChars above).
    queueWhenFull: () => settings.agent.queueWhenFull,
    onChildAbort: (parentRunId, cause) => void spawnRef.current?.abort(parentRunId, cause),
    worktreeDiag,
    resolveModelHint: models.resolveHint,
    availableModels: models.available,
    onDeadlineNotice: sendDeadlineNotice,
    // consult (plan §6 C-12/D-14): per-run tool factory + nested-Agent-tool
    // whitelist resolver + physical-reap cleanup callback, all forwarded
    // through consultRef so the adapter compiles before wireConsult exists.
    consult: (selfRunId, selfCwd, whitelist) => consultRef.current?.depsFactory(selfRunId, selfCwd, whitelist),
    consultResolveExperts: (refs) => {
      if (!consultRef.current) throw new Error("consult is not wired yet");
      return consultRef.current.resolveExperts(refs);
    },
    onReaped: (runId, forkSessionFrom, sessionId) => {
      consultRef.current?.onReaped(runId, forkSessionFrom);
      // bash-timeout-grace plan §3.2 (P5): defensive fan-out — `sealAndKill`
      // is idempotent, so this is a no-op for the (normal) case where
      // `sealBeforeTerminal` already sealed the session; it only matters for
      // the two late-arrival paths (E18), which never had a chance to run
      // through the runner's own `sealBeforeTerminal` first.
      if (sessionId !== undefined) childBashRegistry.sealAndKill(sessionId, BASH_JOB_SEAL_GRACE_MS);
    },
    sealSession: (runId, sessionId) => childBashRegistry.sealAndKill(sessionId, BASH_JOB_SEAL_GRACE_MS)?.facts,
    onSessionSeen: (runId, sessionId) => {
      childBashRegistry.attachHost(sessionId, hostViewFor(runId));
      // §3.6 boundary telemetry: correlate any pending noteToolReturn calls
      // against this run's tool history once it is observable.
      checkBashToolReturnLag(pendingToolReturns, warnedToolLag, query.get(runId)?.diag.toolHistory, (message) =>
        console.warn(`[pi-subagent] ${message}`),
      );
    },
    childBashJobsEnabled: settings.bashJobs.childSessions,
  });
  runnerRef.current = runner; // M4: 接通 watchdog 的晚绑定
  const spawn = createSpawnService({
    types,
    pool,
    runner,
    budget: settings.budget,
    maxNestedDepth: settings.maxNestedDepth,
    // D-16：extend.enabled=false 时合并后钳 maxExtensions=0，宽限/延长一并关闭
    extensionsEnabled: settings.extend.enabled,
    runIdTaken: (id) => taken.has(id),
    // Fuzzy model-hint resolution is the shared Stack.models port (above);
    // spawn admission reuses it unchanged (plan §4.10). The same live list also
    // feeds self-correcting unknown-hint errors.
    resolveModelHint: models.resolveHint,
    availableModels: models.available,
    // Strict provider/id admission: the same exact lookup PiSessionDriver's
    // create() would fail on, done before a run exists. Fail-open — a missing
    // / throwing / still-empty registry reports "unavailable" (undefined) and
    // never blocks a spawn.
    modelExists: (m: { provider: string; id: string }) => {
      let registry: ModelLookupLike | undefined;
      try {
        registry = ctx.modelRegistry as ModelLookupLike | undefined; // live getter; may throw on a replaced session
      } catch {
        registry = undefined;
      }
      return registryModelExists(registry, m);
    },
    // quota-plan §4.1/§6：额度闸门注入（同步、只读缓存、零 IO、零 await——
    // QuotaGateDeps 的类型就杜绝了 spawn 路径发请求）。enabled=false ⇒
    // quotaRef.current 为空 ⇒ 恒放行（R11）；gate=false ⇒ 整个不注入。
    ...(settings.quota.gate
      ? {
          quotaGate: (model: { provider: string; id: string }) => {
            const quota = quotaRef.current;
            if (quota === undefined) return undefined;
            return evaluateQuotaGate(model, {
              verdictFor: (p) => quota.service.verdictFor(p),
              // 替代链只推荐 /models 里激活的模型（scope ∩ available）。
              available: models.recommendable,
              // E 包 Minor 8：settings 的 number 经 toLadderLevel 收窄，无裸 as。
              blockAtLevel: toLadderLevel(settings.quota.gateLevel),
              now: systemClock.now(),
              isSubscription: parseSubscriptionProviders(settings.quota.subscriptionProviders),
            });
          },
        }
      : {}),
    // quota-plan §6「候选标记」：unknown-hint 错误的 Available 列表附额度标记
    // （L0 无标记，输出与今天逐字节相同）；enabled=false 时恒 undefined。
    quotaAnnotate: (candidate) => {
      const quota = quotaRef.current;
      if (quota === undefined) return undefined;
      return quotaAnnotation(candidate, (p) => quota.service.verdictFor(p));
    },
    onLabel: (label, target, info) =>
      info.resumed ? mentionRef.current?.reassign(label, target) : mentionRef.current?.register(label, target),
    ...(fabric ? { onSpawnEdge: (parent, child) => fabric.tree.appendEdge(parent, child) } : {}),
    onOutcomeAcked: (outcome) => {
      try {
        notifier.ack(outcome.runId, outcome.diag.generation, { extensionOwner: "spawnAndWait" });
      } catch {
        // Best effort only.
      }
    },
    notifyTerminalFailure: (outcome) => {
      const payload = {
        key: deliveryKey(outcome.runId, outcome.diag.generation),
        runId: outcome.runId,
        generation: outcome.diag.generation,
        status: outcome.status,
        textPreview: outcome.text ?? "",
        ...(outcome.diag.label === undefined ? {} : { label: outcome.diag.label }),
        ...((outcome.error?.message ?? outcome.timeoutReason)
          ? { failReason: outcome.error?.message ?? outcome.timeoutReason }
          : {}),
        diag: {
          phase: outcome.diag.phase,
          status: outcome.status,
          pendingTools: outcome.diag.pendingTools,
          staleInputs: outcome.diag.staleInputs,
          degraded: outcome.diag.degraded.length,
        },
        createdAt: outcome.diag.createdAt,
        reconcileRound: 0,
      } satisfies DeliveryPayload;
      let existing: ReturnType<Notifier["peek"]>;
      try {
        existing = notifier.peek(payload.key);
      } catch {
        existing = undefined;
      }
      if (existing === "delivered" || existing === "consumed" || existing === "pending" || existing === "batched")
        return;
      if (existing === "staged") {
        notifier.finalize(outcome.runId, outcome.diag.generation, payload);
        return;
      }
      notifier.enqueue(payload);
    },
    onSnapshot: (snapshot) => {
      // M-D: announce a run exactly once, as soon as it has actually started
      // (diag.startedAt set on slot_acquired). The previous heuristic
      // (startedAt === enqueuedAt) silently never fired for any run that
      // waited ≥1ms in the queue — consumers like pi-hud saw zero events.
      if (snapshot.diag.startedAt !== undefined && !announcedStarts.has(snapshot.runId)) {
        announcedStarts.add(snapshot.runId);
        pi.events.emit("subagent:started", { runId: snapshot.runId, at: snapshot.updatedAt });
      }
      usageRef.current?.poke(); // M-E: start/refresh the 1Hz cost broadcast
      if (fabric) {
        if (snapshot.status === "running") {
          fabric.tree.markRunning(snapshot.runId);
          fabric.mailbox.pump(snapshot.runId);
        }
        if (["completed", "failed", "timed_out", "aborted"].includes(snapshot.status))
          fabric.mailbox.onRunSettled(snapshot.runId);
      }
      // consult (plan §6 D-14): cap-watcher fan-out tap — no timer, purely
      // snapshot-driven; consultRef is unset for the brief window before
      // wireConsult runs below, during which no consult run can exist yet.
      consultRef.current?.dispatchSnapshot(snapshot);
    },
  });
  spawnRef.current = spawn;
  worktreeDiag.current = (runId, disposition) => spawn.markWorktreeDisposition?.(runId, disposition);
  // workflow-worktree plan D13 (v2.1 condition 2): register THIS stack's
  // durable sink for late worktree dispositions — registerDispositionSink
  // unconditionally overwrites whoever was registered before (the same
  // Symbol.for holder every stack shares, so a same-module rebuild or a
  // fresh `/reload` module both "just work" without needing to release
  // first). `worktreeLate.dispose()` is the single teardown entry point:
  // stops this stack's spawn-service waiters/timers, flips the
  // runtime-adapter's write-back to redirect-only, and releases the sink
  // registration so a write with nothing left to receive it warns instead
  // of reaching a torn-down closure.
  const worktreeSinkToken = {};
  registerDispositionSink(worktreeSinkToken, (entry) => {
    try {
      pi.appendEntry("subagent:worktree-disposition", entry);
    } catch {
      /* best effort — see worktree-disposition-sink.ts's own doc comment */
    }
  });
  const worktreeLate: { dispose(): void } = {
    dispose(): void {
      spawn.dispose?.();
      runner.dispose?.();
      releaseDispositionSink(worktreeSinkToken);
    },
  };
  previousWorktreeLate = worktreeLate;
  // workflow-worktree plan §3 (P4 wt-orphans): read-only startup discovery of worktree
  // directories a dead/gone owner left behind (§0 decision 8 — no automatic GC, ever).
  // `worktreeOrphans()` below re-scans live on every call (bounded, synchronous fs, no
  // exec, no writes) so `/agent status` always sees the current picture; it does NOT gate
  // on `settings.worktree.enabled` (confirmed with the plan author — a leftover from
  // before the feature was disabled is still on disk and still needs cleaning).
  const worktreeOrphansSelf = { pid: process.pid, procStartedAt: processStartedAt() };
  const worktreeOrphans = (): WorktreeOrphanScanResult =>
    scanWorktreeOrphans({
      root: worktreeRoot(),
      isPidAlive,
      procStartOf,
      tracked: trackedWorktrees(),
      self: worktreeOrphansSelf,
      now: () => systemClock.now(),
    });
  // workflow-worktree plan §3 (P4 fix, 2026 review acceptance turn-back): the startup
  // discovery scan used to run scanWorktreeOrphans() SYNCHRONOUSLY right here, inside
  // session_start's own critical path — a slow/NFS-backed root (disk contention,
  // permissions) would block session_start itself. It is now fire-and-forget (`void
  // runOrphanStartupScan(...)`, never awaited from this function), reads with
  // fs/promises-based `scanWorktreeOrphansAsync`, and is bounded by its own 5s unref'd
  // timeout so a hung/slow filesystem can never hang the process it was meant to protect
  // either — past the timeout the scan is simply abandoned (no notify, diagnostic only).
  // `worktreeOrphansLiveState.live` flips to false at the top of the NEXT
  // `buildSessionStack` (`previousWorktreeOrphansStartup?.dispose()`, same-module rebuild)
  // or via `Stack.worktreeOrphansStartup` in index.ts's `session_shutdown` (covers
  // `/reload`) — either path guarantees a scan that settles after this stack was
  // rebuilt/torn down can never fire a stale notify. The once-per-PROCESS notify flag
  // (`Symbol.for`, same exemption class as HOST_KEY) is set only once `ctx.hasUI` was true
  // AND the notify call itself did not throw, so a headless/print-mode session_start never
  // burns the one chance a later TUI session would have had.
  const worktreeOrphansLiveState = { live: true };
  const worktreeOrphansStartup: { dispose(): void } = {
    dispose(): void {
      worktreeOrphansLiveState.live = false;
    },
  };
  previousWorktreeOrphansStartup = worktreeOrphansStartup;
  const WORKTREE_ORPHANS_NOTIFIED_KEY = Symbol.for("pi-subagent:worktree-orphans-notified");
  void runOrphanStartupScan({
    hasUI: ctx.hasUI,
    scan: (signal) =>
      scanWorktreeOrphansAsync({
        root: worktreeRoot(),
        isPidAlive,
        procStartOf,
        tracked: trackedWorktrees(),
        self: worktreeOrphansSelf,
        now: () => systemClock.now(),
        signal,
      }),
    isLive: () => worktreeOrphansLiveState.live,
    alreadyNotified: () => Boolean((globalThis as Record<symbol, unknown>)[WORKTREE_ORPHANS_NOTIFIED_KEY]),
    markNotified: () => {
      (globalThis as Record<symbol, unknown>)[WORKTREE_ORPHANS_NOTIFIED_KEY] = true;
    },
    notify: (message) => ctx.ui.notify(message, "warning"),
    onDiagnostic: (message) => console.warn(`[pi-subagent] ${message}`),
  });
  // Static fallback for the dynamic per-run wait default (only reached when a
  // snapshot has no deadlineAt yet): the configured run budget + abort grace +
  // settlement headroom, so it tracks `/agent settings` budget changes.
  // 宽限/延长可能让 run 活过此值；进过宽限（diag.overtime 存在）的 run 由
  // wait() 的动态基准（hardDeadlineAt）接管（RK-5），此处数值不变。
  query = createQueryService({
    registry: createLiveRunRegistry(spawn, store),
    runner,
    clock: systemClock,
    defaultWaitMs: settings.budget.totalMs + settings.budget.abortGraceMs + 30_000,
  });
  // consult (plan §6 D-14/D-16): wired now that both `spawn` and `query`
  // exist — consultRef.current is filled synchronously before this
  // buildSessionStack call returns, so every dispatch/consult path above
  // (adapter deps, onSnapshot tap) sees a live wiring by the time any run
  // can actually reach them. Unconditional (mirrors the sweepForkDir call
  // above): the wiring itself degrades to a no-op resolveExperts/depsFactory
  // when settings.consult.enabled is false (src/consult/index.ts).
  const priceOf = (
    m: { provider: string; id: string },
    contextTokens: number,
  ): { input: number; cacheWrite: number } | undefined => {
    const cost = ctx.modelRegistry.find(m.provider, m.id)?.cost;
    if (!cost) return undefined;
    // review-3 #7①: request-wide tiered pricing — the highest tier whose
    // `inputTokensAbove` the estimate exceeds applies to the full request.
    const tier =
      [...(cost.tiers ?? [])]
        .filter((t) => contextTokens > t.inputTokensAbove)
        .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0] ?? cost;
    return { input: tier.input, cacheWrite: tier.cacheWrite };
  };
  const consultForkStore: ConsultForkStore = {
    // D10 (workflow-worktree plan §2): wrapped, not passed directly — the
    // raw functions' 3rd positional parameter is `dir` (defaulted to
    // `consultSessionDir()`), not `opts`, so the interface's `opts` must be
    // forwarded as the 4th argument with `dir` left at its default.
    forkExpertSession: (sourceFile, fallbackCwd, opts) =>
      forkExpertSession(sourceFile, fallbackCwd, undefined, opts?.forceCwd ? { forceCwd: true } : {}),
    forkMainSession: (sourceFile, fallbackCwd, opts) =>
      forkMainSessionSnapshot(sourceFile, fallbackCwd, undefined, opts?.forceCwd ? { forceCwd: true } : {}),
    removeForkFile,
    resolveForkCwd,
    sweepForkDir: () => sweepForkDir(consultSessionDir(), FORK_TTL_MS),
  };
  const consult = wireConsult({
    settings: () => settings.consult,
    query,
    spawnService: spawn,
    priceOf,
    forkStore: consultForkStore,
    consultDir: consultSessionDir(),
    prefetchedEntries,
    mainSessionFacts: () => mainSessionFactsFrom(ctx),
  });
  consultRef.current = consult;
  // M9: created early — the fleet widget below lists in-flight workflows.
  const workflowActivity = createWorkflowActivityRegistry();
  // M-E: live usage broadcaster (channel "subagent:usage", 1Hz while active).
  const usageBroadcaster = new UsageBroadcaster({
    list: () => query.list(),
    emit: (event) => pi.events.emit("subagent:usage", event),
    clock: systemClock,
  });
  usageRef.current = usageBroadcaster;
  previousUsageBroadcaster = usageBroadcaster;
  // D5: build the manager before the widget so its synchronous first frame can
  // receive the manager-bound list/tail closures below.
  const bashJobs = bashJobsEnabled(settings) ? buildBashJobManager(pi, ctx, settings) : undefined;
  previousBashJobs = bashJobs;

  const keepalive = settings.cacheTtl.keepalive
    ? createCacheKeepaliveService({
        clock: systemClock,
        ctx,
        sessionId: currentSessionId(ctx),
        settings: settings.cacheTtl,
        backgroundBusy: () =>
          query.list().some((s) => ["queued", "starting", "running", "stopping"].includes(s.status)) ||
          (bashJobs?.backgroundJobCount() ?? 0) > 0 ||
          // A background workflow between child runs is still background work.
          workflowActivity.list().length > 0,
        isCurrent: (self) => previousKeepalive === self,
        // Lazily read: `adaptive` is constructed below, so this closure must
        // resolve at publish time, not at construction time.
        adaptiveSnapshot: () => previousAdaptive?.snapshot(),
        // F1: stand down while adaptive's settled 1h entry covers the prefix (lazy, same reason).
        adaptiveCoversPrefix: (horizonMs) => previousAdaptive?.coversPrefix(horizonMs) === true,
        // task #14: skip the one-shot 1h upgrade for a prefix the next switch discards.
        switchImminent: () => isSwitchImminentNow(compactHint, ctx),
        appendEntry: (type, data) => pi.appendEntry(type, data),
        emit: (channel, payload) => pi.events.emit(channel, payload),
      })
    : undefined;
  previousKeepalive = keepalive;

  // adaptive plan.md §3.2: the three strong signals are injected as one closure
  // (same pattern as keepalive's `backgroundBusy`). `uiPrompts` / `activeTools`
  // are counted inside the service itself from forwarded events. A throwing
  // `signals()` degrades to all-zero ⇒ never upgrades (§15 R7).
  const adaptive = settings.cacheTtl.adaptiveEnabled
    ? createCacheAdaptiveService({
        clock: systemClock,
        ctx,
        sessionId: currentSessionId(ctx),
        settings: settings.cacheTtl,
        // Background workflows count as subagent work (running-only `list()`, never the display linger).
        signals: () =>
          computeAdaptiveSignals(
            query.list(),
            bashJobs?.backgroundJobCount() ?? 0,
            systemClock.now(),
            workflowActivity.list(),
          ),
        // D1: the predictor's warm/cold split must see the pinger's evidence —
        // `keepalive` is constructed just above, so this is a direct read (the
        // reverse direction needs the lazy `previousAdaptive` closure instead).
        provenCacheReadAt: () => keepalive?.provenCacheReadAt(),
        // F1: no new 1h prefix for gaps the pinger already bridges.
        keepaliveHorizonMs: (prefixTokens) => keepalive?.gapHorizonMs(prefixTokens),
        // task #14: no new 1h prefix (entry fee) for one compact-hint says is about to be discarded.
        switchImminent: () => isSwitchImminentNow(compactHint, ctx),
        isCurrent: (self) => previousAdaptive === self,
        appendEntry: (type, data) => pi.appendEntry(type, data),
        emit: (channel, payload) => pi.events.emit(channel, payload),
        // field-2026-09-24 §3.1: budgets/breaker are session-permanent — a rebuild
        // (`/reload`) rehydrates them from this branch's own audit entries.
        // getBranch() (not getEntries) so an abandoned fork's trips don't leak.
        restoredState: readBack
          ? readBackAdaptiveSessionState(
              (ctx.sessionManager as { getBranch?: () => readonly unknown[] }).getBranch?.() ?? [],
            )
          : undefined,
      })
    : undefined;
  previousAdaptive = adaptive;

  // quota（quota-plan §4.1）：额度感知派单——与 keepalive/adaptive 同款可选构造 +
  // previous* 交接。构造零副作用（demotion store 惰性加载）；providers="" 时
  // 零 adapter ⇒ 零网络（测试隔离位）。
  const quota = settings.quota.enabled
    ? createQuotaStack({
        settings: settings.quota,
        clock: systemClock,
        statePath: join(getAgentDir(), "quota-state.json"),
        ...(settings.quota.hud
          ? {
              setStatus: (text: string | undefined) => safeSetQuotaStatus(ctx, text),
              theme: () => readQuotaStatusTheme(ctx),
            }
          : {}),
        warn: (message) => console.warn(`[pi-subagent] ${message}`),
      })
    : undefined;
  previousQuota = quota;
  quotaRef.current = quota;
  // 预热：fire-and-forget，绝不 await（session_start 必须保持同步快）；
  // refreshIfStale 永不返回被拒 Promise，失败静默降级（R1）。
  quota?.service.refreshIfStale();

  // compact-hint 动态阈值（dynamic-threshold-plan.md D3）：mode=off / compact 关时不构造
  //（§11.3 回滚保证 1）；print/json 构造 ⇒ wire 内返回惰性 runtime。所有权在 Stack（同时经
  // compactHint.dynamic 引用同一对象）；dispose 由 index.ts 的 session_shutdown / session_start
  // 防御性清理负责（P1-4），buildSessionStack 内不做 previous-runtime 交接（无 timer/外部资源）。
  const dynamicConfig = settings.compact.dynamicThreshold ?? DEFAULT_DYNAMIC_THRESHOLD_SETTINGS;
  const dynamic =
    settings.compact.enabled && dynamicConfig.mode !== "off"
      ? wireDynamicThreshold({
          ctx: { mode: ctx.mode, sessionManager: ctx.sessionManager },
          config: dynamicConfig,
          sessionId: currentSessionId(ctx),
          telemetryFilePath: join(getAgentDir(), "telemetry", "compact-switch.jsonl"),
          now: () => systemClock.now(),
          appendEntry: (type, data) => pi.appendEntry(type, data),
          readBranch: () => {
            try {
              const sm = ctx.sessionManager as { getBranch?: () => readonly unknown[] } | undefined;
              return sm?.getBranch?.() ?? [];
            } catch {
              return [];
            }
          },
          quota: {
            enabled: settings.quota.enabled,
            isSubscription: parseSubscriptionProviders(settings.quota.subscriptionProviders),
            // WindowVerdict.resetAt → SubscriptionWindowLike.resetAtMs 的字段名适配（§8.2）。
            verdictFor: (provider) => {
              const verdict = quotaRef.current?.service.verdictFor(provider);
              if (verdict === undefined) return undefined;
              return {
                stale: verdict.stale,
                windows: verdict.windows.map((w) => ({
                  usedPct: w.usedPct,
                  ...(w.resetAt !== undefined ? { resetAtMs: w.resetAt } : {}),
                })),
              };
            },
          },
        })
      : undefined;
  compactHint.dynamic = dynamic;

  // X7b: always-on fleet widget above the editor. The controller self-probes
  // ctx.ui.setWidget and goes inert (no timer, no throw) in non-interactive
  // modes; settings.fleetWidget=false skips it entirely.
  if (settings.fleetWidget) {
    // M10: theme-color injector — ctx.ui.theme is pi's live Theme (falls back
    // to plain text on older pi builds without it).
    const uiTheme = (ctx.ui as { theme?: { fg(color: string, text: string): string } } | undefined)?.theme;
    const widget = new FleetWidgetController({
      ui: ctx.ui,
      query,
      clock: systemClock,
      idleBudgetMs: settings.budget.idleMs,
      maxRows: settings.fleetWidgetMaxRows,
      receiptOf: (runId) => contextReceipt.receiptOf(runId),
      mentionNoteOf: (runId) => mentionNotes.get(runId),
      terminalLingerMs: settings.fleetTerminalLingerMs,
      awaitNotificationMs: settings.fleetAwaitNotificationMs,
      deadlineWarnMs: settings.fleetDeadlineWarnMs,
      pruneReceipts: (keep, now) =>
        contextReceipt.prune(keep, now, {
          lingerMs: settings.fleetTerminalLingerMs,
          awaitMs: settings.fleetAwaitNotificationMs,
        }),
      ...(uiTheme
        ? {
            color: (tone, text) => {
              switch (tone) {
                case "warn":
                  return uiTheme.fg("warning", text);
                case "crit":
                  return uiTheme.fg("error", text);
                case "muted":
                  return uiTheme.fg("muted", text);
                case "success":
                  return uiTheme.fg("success", text);
                case "header":
                  return uiTheme.fg("accent", text);
                default:
                  return text;
              }
            },
          }
        : {}),
      // M9: ⚙ workflow group headers in the agent tree — children (parentRunId
      // === workflowId) are indented under their workflow instead of floating
      // as orphan ↳ rows. M11: the display feed additionally carries frozen
      // terminal snapshots for the pipeline view's linger window — `list()`
      // itself must stay running-only (it is the background-busy counter for
      // keepalive / deferred reload / status).
      workflows: () => workflowActivity.listForDisplay(),
      ...(bashJobs
        ? {
            bashJobs: () => bashJobs.list(),
            readBashTail: (record: JobRecord, sizeHint?: number) => readBashJobTail(bashJobs, record, sizeHint),
          }
        : {}),
      // Todo widget mount-order fix: the todo widget (src/todo/index.ts)
      // announces its own hidden→visible transitions on this channel; see
      // src/ui/widget-mount-events.ts for the full rationale. `pi.events` is
      // the same cross-module bus both sides already use elsewhere in this
      // file, so this wiring never imports either module's implementation
      // into the other.
      onExternalWidgetMounted: (handler) => pi.events.on(TODO_WIDGET_MOUNTED_EVENT, handler),
    });
    widgetRef.current = widget;
    previousFleetWidget = widget;
  }
  // /goal：session 级运行态重建（goal-plan v4 条件 8）。读回走 getBranch()
  // （MAJ-5：防 fork 废弃分支复活 goal）；读回到的 active 一律已降级 paused
  // （条件 2，store 层完成）。readBack 不可用时仅内存态（G5a 同款降级）。
  const goalBranch = readBack
    ? ((ctx.sessionManager as { getBranch?: () => readonly unknown[] }).getBranch?.() ?? [])
    : [];
  const rehydratedGoal = readBackGoalRecord(goalBranch, sessionReason);
  const goal: GoalSession = { settings: settings.goal, record: rehydratedGoal.record };
  if (rehydratedGoal.record) {
    try {
      if (typeof ctx.ui?.setStatus === "function") ctx.ui.setStatus("goal", goalBadgeText(rehydratedGoal.record));
    } catch {
      // 徽标 best effort
    }
    if (rehydratedGoal.notify && ctx.hasUI) {
      try {
        ctx.ui.notify(buildResumeHintText(rehydratedGoal.record), "info");
      } catch {
        // best effort
      }
    }
  }
  const scheduler = createScheduler({ spawn });
  const rpc = createRPCServer({ events: pi.events, spawn, query });
  // §3.6: prepare the session directory before recover so migrated/orphaned
  // records enter the normal adjudication and notification path.
  let bashJobRecovery: { dispose(): void } | undefined;
  if (bashJobs) {
    const rootDir = settings.bashJobs.dir ?? join(getAgentDir(), "bash-jobs");
    const selfDirName = sanitizeSessionDirName(currentSessionId(ctx));
    const processPort = createProcessPort({
      ...(settings.bashJobs.shellPath !== undefined ? { shellPath: settings.bashJobs.shellPath } : {}),
      drainTimeoutMs: settings.bashJobs.drainTimeoutMs,
    });
    const dirOptions = {
      rootDir,
      selfDirName,
      retentionMs: settings.bashJobs.retentionMs,
      clock: systemClock,
      processPort,
      sessionId: currentSessionId(ctx),
      skipDirNames: [selfDirName],
      warn: (message: string) => console.warn(`[pi-subagent] ${message}`),
    } as const;
    bashJobRecovery = scheduleBashJobRecovery({
      runRecovery: async (signal) => {
        // bash-timeout-grace plan §2.5 steps 1/2 (P5): the crash-handoff
        // sync prefix (`previous.exportLocalJobs()` → `current.adoptLocalJobs()`,
        // both purely in-memory, no I/O — `handoffInProcess`'s own doc comment)
        // runs FIRST, before any of the awaited I/O below — so even if
        // `migrateFlatRecords`/`adoptOrphans`/`recover()` hang forever on a
        // slow/broken filesystem, a job handed off from the previous stack
        // already has its deadline timer rearmed on `bashJobs` by the time
        // this function's first `await` suspends (T12).
        try {
          if (prevBashJobs) await handoffInProcess(prevBashJobs, bashJobs, dirOptions, signal);
          await migrateFlatRecords(dirOptions, selfDirName, undefined, signal);
          await migrateFlatRecords(dirOptions, undefined, [selfDirName], signal);
          await adoptOrphans(dirOptions, prevBashJobs ? [basename(prevBashJobs.dir)] : [], signal);
          await bashJobs.recover(signal);
          if (prevBashJobs && prevBashJobs.dir !== bashJobs.dir) {
            await prevBashJobs.drain();
            await sweepHandoffRemnants(
              prevBashJobs.dir,
              new Set(bashJobs.list().map((record) => record.jobId)),
              dirOptions,
              signal,
            );
          }
        } finally {
          widgetRef.current?.refresh();
        }
      },
      runCleanup: (signal) => reconcileRootDir(dirOptions, signal),
      warn: (message) => console.warn(`[pi-subagent] ${message}`),
    });
  }
  previousBashJobRecovery = bashJobRecovery;

  // M3.6 (CC3, §11 M3.6): the workflow engine's session-lifetime pieces —
  // built unconditionally (cheap: a spawner adapter closure + a budget
  // object + an empty activity map), but `workflow.enabled` gates whether
  // `index.ts` ever registers the `SubagentWorkflow` tool that would
  // actually call `createOrchestrator()` (settings.workflow.enabled default
  // `false` — the engine stays entirely inert until then).
  // (M9: created above the fleet widget, which lists in-flight workflows.)
  // workflow-experts (docs/dev/workflow-experts/plan.md §4.8): the workflow
  // engine's own dispatch-time expert resolver — always `completedOnly:
  // true` (D8), late-bound through `consultRef` exactly like
  // `consultResolveExperts` above (package C, `src/consult/index.ts`, already
  // exposes `resolveExperts(refs, opts?: { completedOnly?: boolean })`).
  const workflowChildSpawner = createWorkflowChildSpawner(spawn, types, {
    resolveExperts: (refs, o) => {
      if (!consultRef.current) throw new Error("consult is not wired yet");
      return consultRef.current.resolveExperts(refs, o);
    },
    // workflow-worktree plan D2: read fresh on every call (not snapshotted
    // at stack-build time) so a `/reload` that flips `worktree.enabled`
    // takes effect for the next agent({isolation}) call immediately.
    worktreeAvailable: () => settings.worktree.enabled,
  });
  const workflowJournalRootDir = settings.workflow.journalDir ?? join(homedir(), ".pi", "agent", "workflows");
  /**
   * workflow-agent-queue §4.5 (stage B): a background workflow's grace /
   * extended notice — the same `subagent:timeout` channel as run notices
   * (never the outbox, D-4), `settings.extend.notify` off ⇒ dropped (the grace
   * window itself still applies), grace wakes the model, extended is
   * display-only. The display name comes from the background registry.
   */
  const sendWorkflowDeadlineNotice = (notice: WorkflowDeadlineNotice): void => {
    if (!shouldDeliverWorkflowDeadlineNotice({ policy: settings.extend.notify })) return;
    const name = workflowRuns.get(notice.workflowId)?.name;
    pi.sendMessage(
      {
        customType: TIMEOUT_NOTICE_TYPE,
        content: formatWorkflowDeadlineNotice(notice, {
          now: systemClock.now(),
          ...(name === undefined ? {} : { name }),
        }),
        display: true,
        details: notice,
      },
      workflowDeliveryOptionsFor(notice),
    );
  };
  const createWorkflowOrchestrator = (workflowId: WorkflowId): Orchestrator =>
    createOrchestrator({
      clock: systemClock,
      createWorkerHost: () => createWorkerHost({ clock: systemClock }),
      spawner: workflowChildSpawner,
      gateRunner: async (cmd, opts) => {
        const result = await pi.exec("bash", ["-c", cmd], {
          timeout: opts.timeoutMs,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        });
        return {
          ok: result.code === 0 && !result.killed,
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
      parentRunId: workflowId,
      journalRootDir: workflowJournalRootDir,
      onDeadlineNotice: sendWorkflowDeadlineNotice,
      emit: (channel, payload) => {
        pi.events.emit(channel, payload);
        workflowActivity.onEvent(channel, payload);
      },
    });
  const workflowRuns = createBackgroundWorkflows({
    clock: systemClock,
    activity: workflowActivity,
    createOrchestrator: createWorkflowOrchestrator,
    onSettled: createWorkflowNoticeSink({
      sendMessage: (message, options) => pi.sendMessage(message, options),
      appendEntry: (customType, data) => pi.appendEntry(customType, data),
      emit: (channel, payload) => pi.events.emit(channel, payload),
      usageOf: (runId) => query.get(runId)?.diag.usage,
      resultMaxChars: () => settings.resultMaxChars,
      now: () => systemClock.now(),
    }),
  });
  previousWorkflowRuns = workflowRuns;
  const workflow: WorkflowSupport = {
    enabled: settings.workflow.enabled,
    defaultBudget: buildWorkflowRunBudget(settings),
    activity: workflowActivity,
    journalRootDir: workflowJournalRootDir,
    createOrchestrator: createWorkflowOrchestrator,
    runs: workflowRuns,
    redeliverPendingNotices: () =>
      redeliverPendingWorkflowNotices({
        branch: () => (ctx.sessionManager as { getBranch?: () => readonly unknown[] }).getBranch?.() ?? [],
        runs: workflowRuns,
        sendMessage: (message, options) => pi.sendMessage(message, options),
        appendEntry: (customType, data) => pi.appendEntry(customType, data),
        now: () => systemClock.now(),
      }),
  };
  return {
    compactHint,
    ...(dynamic ? { dynamic } : {}),
    models,
    spawn,
    query,
    contextReceipt,
    orphans: reaper.registry,
    notifier,
    mention,
    mentionNotes,
    scheduler,
    rpc,
    workflow,
    goal,
    consult,
    worktreeLate,
    worktreeOrphans,
    worktreeOrphansStartup,
    ...(widgetRef.current ? { fleetWidget: widgetRef.current } : {}),
    ...(bashJobs ? { bashJobs } : {}),
    ...(bashJobRecovery ? { bashJobRecovery } : {}),
    ...(keepalive ? { keepalive } : {}),
    ...(adaptive ? { adaptive } : {}),
    ...(quota ? { quota: quota.service, quotaHint: quota.hintState } : {}),
    ...(fabric ? { fabric: { dispose: () => fabric.mailbox.dispose(), pump: () => fabric.mailbox.pump() } } : {}),
  };
}
