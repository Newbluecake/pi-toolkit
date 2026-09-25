import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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
import { readScopedModels, recommendableModels } from "./config/available-models.js";
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
  overtimeTail,
  shouldDeliverDeadlineNotice,
  TIMEOUT_NOTICE_TYPE,
} from "./delivery/deadline-notice.js";
import { parseDeliveryKey } from "./core/delivery-key.js";
import {
  consultSessionDir,
  forkExpertSession,
  FORK_TTL_MS,
  removeForkFile,
  resolveForkCwd,
  sweepForkDir,
} from "./consult/fork-store.js";
import { wireConsult, type ConsultWiring } from "./consult/index.js";
import type { ConsultForkStore } from "./consult/tool.js";
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
import { FleetWidgetController } from "./ui/fleet-widget.js";
import type { GoalSession, GoalSessionStartReason } from "./goal/state.js";
import { readBackGoalRecord } from "./goal/store.js";
import { buildResumeHintText, goalBadgeText } from "./goal/texts.js";
import { createWorkflowActivityRegistry, type WorkflowActivityRegistry } from "./workflow/activity.js";
import { createWorkerHost } from "./workflow/lifecycle.js";
import { createOrchestrator, type Orchestrator } from "./workflow/orchestrator.js";
import { buildWorkflowRunBudget } from "./workflow/run-budget.js";
import { createWorkflowChildSpawner } from "./workflow/spawner-adapter.js";
import type { WorkflowId, WorkflowRunBudget } from "./workflow/types.js";

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
let previousFabricMailbox: ReturnType<typeof createFabricMailbox> | undefined;
/** cache-ttl keepalive (plan.md §2.2): same rebuild-dispose pattern as the usage broadcaster. */
let previousKeepalive: CacheKeepaliveService | undefined;
/** cache-ttl adaptive (adaptive plan.md §9): same rebuild-dispose pattern as the keepalive service. */
let previousAdaptive: CacheAdaptiveService | undefined;
/** quota（quota-plan §4.1）：与 keepalive/adaptive 同款「下一次 build 顶部 dispose」
 *  交接。`/reload` 走 session_shutdown dispose Stack.quota（M3：QuotaService.dispose
 *  是唯一清理所有者且幂等），与 previousFleetWidget 同一套双路径纪律。 */
let previousQuota: QuotaStack | undefined;

/** customType of the bash job completion notice (§5) — distinct from `subagent:notification`. */
export const BASH_JOB_NOTIFICATION_TYPE = "bash-job:notification";
/** Output tail attached to a completion notice (§5). */
export const BASH_JOB_TAIL_BYTES = 1024;
export const BASH_JOB_TAIL_LINES = 10;

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

function currentSessionId(ctx: ExtensionContext): string {
  try {
    return (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.() ?? "";
  } catch {
    return "";
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
  previousFabricMailbox?.dispose();
  previousFabricMailbox = undefined;
  previousKeepalive?.dispose();
  previousKeepalive = undefined;
  previousAdaptive?.dispose();
  previousAdaptive = undefined;
  previousQuota?.dispose();
  previousQuota = undefined;

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
        autoBackgrounded: (id) => query.get(id)?.diag.autoBackgroundedAt !== undefined,
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
    onReaped: (runId, forkSessionFrom) => consultRef.current?.onReaped(runId, forkSessionFrom),
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
    forkExpertSession,
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
          (bashJobs?.backgroundJobCount() ?? 0) > 0,
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
        signals: () => computeAdaptiveSignals(query.list(), bashJobs?.backgroundJobCount() ?? 0, systemClock.now()),
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
      // as orphan ↳ rows.
      workflows: () => workflowActivity.list(),
      ...(bashJobs
        ? {
            bashJobs: () => bashJobs.list(),
            readBashTail: (record: JobRecord, sizeHint?: number) => readBashJobTail(bashJobs, record, sizeHint),
          }
        : {}),
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
    void (async () => {
      await migrateFlatRecords(dirOptions, selfDirName);
      await migrateFlatRecords(dirOptions, undefined, [selfDirName]);
      if (prevBashJobs) await handoffInProcess(prevBashJobs, bashJobs, dirOptions);
      await adoptOrphans(dirOptions, prevBashJobs ? [basename(prevBashJobs.dir)] : []);
      await bashJobs.recover();
      if (prevBashJobs && prevBashJobs.dir !== bashJobs.dir) {
        await prevBashJobs.drain();
        await sweepHandoffRemnants(
          prevBashJobs.dir,
          new Set(bashJobs.list().map((record) => record.jobId)),
          dirOptions,
        );
      }
    })()
      .catch((error: unknown) => {
        console.warn(`[pi-subagent] bash job recovery failed (jobs stay unadopted): ${String(error)}`);
      })
      .finally(() => widgetRef.current?.refresh());
    void reconcileRootDir(dirOptions).catch((error: unknown) => {
      console.warn(`[pi-subagent] bash job directory reconciliation failed: ${String(error)}`);
    });
  }

  // M3.6 (CC3, §11 M3.6): the workflow engine's session-lifetime pieces —
  // built unconditionally (cheap: a spawner adapter closure + a budget
  // object + an empty activity map), but `workflow.enabled` gates whether
  // `index.ts` ever registers the `SubagentWorkflow` tool that would
  // actually call `createOrchestrator()` (settings.workflow.enabled default
  // `false` — the engine stays entirely inert until then).
  // (M9: created above the fleet widget, which lists in-flight workflows.)
  const workflowChildSpawner = createWorkflowChildSpawner(spawn, types);
  const workflowJournalRootDir = settings.workflow.journalDir ?? join(homedir(), ".pi", "agent", "workflows");
  const workflow: WorkflowSupport = {
    enabled: settings.workflow.enabled,
    defaultBudget: buildWorkflowRunBudget(settings),
    activity: workflowActivity,
    journalRootDir: workflowJournalRootDir,
    createOrchestrator(workflowId) {
      return createOrchestrator({
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
        emit: (channel, payload) => {
          pi.events.emit(channel, payload);
          workflowActivity.onEvent(channel, payload);
        },
      });
    },
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
    ...(widgetRef.current ? { fleetWidget: widgetRef.current } : {}),
    ...(bashJobs ? { bashJobs } : {}),
    ...(keepalive ? { keepalive } : {}),
    ...(adaptive ? { adaptive } : {}),
    ...(quota ? { quota: quota.service, quotaHint: quota.hintState } : {}),
    ...(fabric ? { fabric: { dispose: () => fabric.mailbox.dispose(), pump: () => fabric.mailbox.pump() } } : {}),
  };
}
