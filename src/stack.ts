import { readBashJobTail } from "./bash/notify.js";
import {
  BASH_JOB_SEAL_GRACE_MS,
  bashJobsEnabled,
  buildBashJobManager,
  checkBashToolReturnLag,
  scheduleBashJobRecovery,
} from "./bash/host.js";
import { buildFabric } from "./fabric/stack.js";
import { buildStackXs, type StackXs, type StackXsInput } from "./fabric/xs/stack.js";
import { currentSessionId } from "./adapters/session-id.js";
import { type CompactHintState } from "./compact-hint/hook.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSecureDomain } from "./secure/domain.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveReserveTokens } from "./compact-hint/pi-settings.js";
import { DEFAULT_DYNAMIC_THRESHOLD_SETTINGS } from "./config/settings.js";
import { wireDynamicThreshold, type DynamicRuntime } from "./compact-hint/dynamic/wire.js";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { systemClock } from "./core/clock.js";
import { type BashJobManager } from "./bash/manager.js";
import {
  adoptOrphans,
  handoffInProcess,
  migrateFlatRecords,
  reconcileRootDir,
  sanitizeSessionDirName,
  sweepHandoffRemnants,
} from "./bash/session-dirs.js";
import { createProcessPort } from "./bash/process.js";
import { readPiShellSettings, type PiShellSettings } from "./bash/pi-shell.js";
import { type JobRecord } from "./bash/types.js";

import { getChildBashRegistry, declareHostBashViewCapability, type HostRunView } from "./bash/child-registry.js";
import { resolveChildSwitchContextGrant } from "./context-switch/capability.js";
import { getChildKeepaliveDisposeRegistry } from "./cache-ttl/child-registry.js";
import { dueAtFor, effectiveDeadlineAt } from "./core/deadline.js";

import { MemoryOutboxStore, MemoryRunStore } from "./core/store.js";
import type {
  DeadlineNotice,
  DeliveryPayload,
  RunId,
  RunSnapshot,
  SubagentExtensionPoints,
  WorktreeDisposal,
} from "./core/types.js";
import { probeReadBackEntries } from "./adapters/pi-compat.js";
import { mergeExtensionPoints } from "./extensions/registry.js";
import { createPiOutboxStore, OUTBOX_CUSTOM_TYPE } from "./adapters/pi-outbox-store.js";
import { type CausalLevel } from "./fabric/wake-level.js";
import { type WakeStatusView } from "./fabric/wake.js";
import { getXsWakeLedger } from "./fabric/xs/wake-ledger.js";
import { RootWakeController } from "./fabric/root-wake.js";
import { xsOn } from "./fabric/xs/switch.js";
import { type NodeRef } from "./core/message.js";
import { wrapWithRunLog, seedRunStoreFromEntries, WORKTREE_DISPOSITION_CUSTOM_TYPE } from "./adapters/pi-run-log.js";
import type { AgentTypeRegistry } from "./config/agent-types.js";
import {
  readScopedModels,
  recommendableModels,
  registryModelExists,
  type ModelLookupLike,
} from "./config/available-models.js";
import { parseStrictModelRef, resolveModelHint } from "./config/model-hint.js";
import type { AgentSettings, SettingsFileReport } from "./config/settings.js";
import { createExternalAgentsPort } from "./external-agent/port.js";
import { RoutingSessionDriver } from "./external-agent/router.js";
import type { ExternalAgentsPort } from "./external-agent/types.js";
import { createCatalogPoolPort, type CatalogPoolPort } from "./quota/pools.js";
import type { QuotaPoolPort } from "./quota/types.js";
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
import { createCoalescer, isCoalescible } from "./delivery/coalescer.js";
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
import { sweepLegacyConsultForks } from "./runtime/legacy-consult-forks.js";
import { UsageBroadcaster } from "./delivery/usage-broadcast.js";
import { createCacheKeepaliveService, type CacheKeepaliveService } from "./cache-ttl/keepalive-service.js";
import { getProviderEvidenceStore } from "./cache-ttl/provider-evidence.js";
import { readBackKeepaliveSessionState } from "./cache-ttl/keepalive-state.js";
import {
  createQuotaStack,
  type QuotaHintState,
  type QuotaProblem,
  type QuotaService,
  type QuotaStack,
} from "./quota/index.js";
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
import type { ScheduleAgent, ScheduleWiring } from "./schedule/agent/wire.js";
import type { BackgroundExecutor } from "./schedule/agent/bg.js";
import { installScheduleExecutors } from "./schedule/agent/executors.js";
import { createQueryService, type QueryService } from "./service/query-service.js";
import { createLiveRunRegistry } from "./service/run-registry.js";
import { createRuntimeRunnerAdapter } from "./service/runtime-adapter.js";
import { createSpawnService, type SpawnService } from "./service/spawn-service.js";
import { TombstoneStore } from "./service/tombstone.js";
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
import { ArchiveControl } from "./archive/control.js";
import { TODO_WIDGET_MOUNTED_EVENT } from "./ui/widget-mount-events.js";
import type { GoalSession, GoalSessionStartReason } from "./goal/state.js";
import { readBackGoalRecord } from "./goal/store.js";
import { buildResumeHintText, goalBadgeText } from "./goal/texts.js";
import { createWorkflowActivityRegistry, type WorkflowActivityRegistry } from "./workflow/activity.js";
import { createWorkerHost } from "./workflow/lifecycle.js";
import { createOrchestrator, type Orchestrator } from "./workflow/orchestrator.js";
import { buildWorkflowRunBudget } from "./workflow/run-budget.js";
import { createWorkflowChildSpawner } from "./workflow/spawner-adapter.js";
import { createLoadActivation, type LoadActivation } from "./sysload/activation.js";
import { evaluateLoadGate, loadBlocked } from "./sysload/gate.js";
import type { LoadHintState } from "./sysload/hook.js";
import type { LoadAdmission, LoadPort } from "./sysload/types.js";
import { parseForEachRef } from "./workflow/isolation-verify.js";
import { createBackgroundWorkflows, type BackgroundWorkflows } from "./workflow/background.js";
import { createWorkflowNoticeSink, redeliverPendingWorkflowNotices } from "./adapters/workflow-notice.js";
import {
  createBackgroundCompletionHub,
  type BackgroundCompletionHub,
  type SendCompletion,
} from "./service/background-completions.js";
import type { WorkflowId, WorkflowRunBudget } from "./workflow/types.js";
import {
  disposeXsSync,
  runRebuildHandoff,
  runStackTeardown,
  type StackTeardownEnv,
  type StackTeardownEntry,
  type TeardownParts,
} from "./stack-teardown.js";
import type { WorkflowDeadlineNotice } from "./workflow/deadline.js";

/**
 * The previous build's teardown-relevant components (src/stack-teardown.ts documents each slot). The next
 * `buildSessionStack` in the SAME module runs the `rebuild-handoff` steps over it (path A): pi's /reload and cross-cwd
 * resume re-import the extension as a fresh module (jiti moduleCache:false), so this starts empty there and the
 * `shutdown` entry (`Stack.dispose`) is the only teardown. The one module-level mutable of this file (I4).
 */
let previousParts: TeardownParts = {};

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
  /**
   * The one teardown entry (src/stack-teardown.ts holds the ordered step lists and the per-component rationale):
   *  - `{kind:"shutdown", reason}` — index.ts's session_shutdown main handler (async: schedule closeEpoch, run drain, seal);
   *  - `{kind:"defensive", nextXsSessionId?}` — index.ts's session_start when this activation already holds a stack (sync);
   *  - `{kind:"rebuild-handoff"}` — the steps the NEXT `buildSessionStack` in this module runs over this build's parts
   *    (sync; includes the components that are not `Stack` members).
   * Idempotent per component; every entry keeps today's gaps (GAP-Gn in the matrix test) until 7b fixes them.
   */
  dispose(entry: { kind: "shutdown"; reason: string }, env: StackTeardownEnv): Promise<void>;
  dispose(entry: { kind: "defensive"; nextXsSessionId?: string | undefined }, env: StackTeardownEnv): void;
  dispose(entry: { kind: "rebuild-handoff" }): void;
  /** C1: the synchronous xs part of session_shutdown (fence event, xs, rootWakeRecovery) — registered early, must stay sync. */
  disposeXsSync(): void;
  compactHint: CompactHintState;
  /** 动态阈值运行时（compact-hint dynamic plan D3；mode=off 或 print/json 构造时缺席或惰性）。
   *  dispose 的接入点在 index.ts 的 session_shutdown / session_start 防御性清理（P1-4）。 */
  dynamic?: DynamicRuntime;
  /** Shared model-hint/registry port (spawn admission + set_model, plan §4.10). */
  models: StackModelPort;
  spawn: SpawnService;
  query: QueryService;
  /**
   * run-persistence plan D5/§4: session_shutdown's synchronous, best-effort
   * flush of still-non-terminal runs (one `shutdown_flush` journal entry
   * each, written into THIS session's log before pi invalidates the ctx).
   * Returns the number of entries written.
   */
  runJournal: { flushPending(runIds: readonly RunId[], shutdownReason: string): number };
  orphans: OrphanRegistry;
  notifier: Notifier;
  contextReceipt: ContextReceiptTracker;
  mention: MentionRegistry;
  /** X6b: latest raw user @ message per run, shown in the fleet widget under the run. */
  mentionNotes: MentionNotes;
  /** scheduled-reports A0: the per-session schedule agent (absent ⇔ schedule.enabled off — the
   *  default; the retired global cron engine is gone). Started by src/index.ts after the build,
   *  shut down FIRST in session_shutdown (closeEpoch). */
  schedule?: ScheduleAgent;
  /** scheduled-reports I1: the background executor + result notes (absent when the agent cannot execute). */
  scheduleBackground?: BackgroundExecutor;
  rpc: RPCServer;
  workflow: WorkflowSupport;
  /** X7b fleet widget; absent when settings.fleetWidget is off. Exposed so session_shutdown
   *  can dispose it: pi's /reload re-imports the extension as a FRESH module (jiti
   *  moduleCache:false), so the module-level previousParts.fleetWidget handoff in
   *  buildSessionStack only covers same-module session swaps (new/fork/resume) — after a
   *  reload the old controller is unreachable module state, and since the stale ctx.ui
   *  closures keep working (no assertActive on setWidget), an undisposed controller's
   *  self-rescheduling 1Hz tick outlives its session FOREVER, pushing setWidget(undefined)
   *  over the new session's frames → the agent tree visibly blinks off/on. */
  fleetWidget?: FleetWidgetController;
  /** bash auto-background job manager; absent when the feature is off (§2.6/R6). */
  bashJobs?: BashJobManager;
  /** web-hub archive plan: the session's archive control (runs/bash display-hiding + the
   *  `subagent:archive` session entry). Absent when `webHub.enabled` is false. */
  archive?: ArchiveControl;
  /**
   * 2026-10-17 shell-resolution revision: pi's own `shellPath` /
   * `shellCommandPrefix` for this stack (read once per build, non-live).
   * `shellPath` feeds the process ports' resolution ladder
   * (`bashJobs.shellPath` → this → pi's default chain); `shellCommandPrefix`
   * is honoured by the bash override exactly like pi's built-in bash tool
   * (`${prefix}\n${command}` — index.ts reads it through this field). Absent
   * iff `bashJobs` itself is absent.
   */
  bashShell?: PiShellSettings;
  /**
   * bash-timeout-grace plan §2.5 step 4/6 (P5): this stack's recovery/cleanup
   * dual-timer handle (absent iff `bashJobs` itself is absent). `dispose()`
   * aborts whichever phase is still outstanding — called at the top of the
   * NEXT `buildSessionStack` (module-level handoff, above) AND by index.ts's
   * `session_shutdown` (covers the fresh-module `/reload` case).
   */
  bashJobRecovery?: { dispose(): void };
  fabric?: { dispose(): void; pump(): void };
  /** Phase-2: absent (not merely inert) while xs is off. */
  xs?: StackXs;
  /** Settings-off reload: supervise old authorizations without exposing/admitting xs. */
  rootWakeRecovery?: RootWakeController;
  /**
   * fabric-cross-session plan §3.9 (W1): causal-level controller; present iff `fabric.enabled ∧ fabric.wake.enabled`.
   * index.ts's `input` hook reads it (`holder.current?.wake`) to reset the root level on proven human input.
   */
  wake?: {
    level: CausalLevel;
    /** G (plan §7): read-only `/agent status` view — counters from `WakeService.stats()` plus level/durability facts. */
    status(): WakeStatusView;
    /** G (plan §7): messages carried into resume run `runId` (committed or reserved); drives `get_run_result` text. */
    inboxCount(runId: string): number;
  };
  /** 提示词缓存保活调度器（plan.md §2）；settings.cacheTtl.keepalive=false 时缺席。 */
  keepalive?: CacheKeepaliveService;
  /** 额度感知派单（docs/dev/quota/quota-plan.md）：同步缓存判定面。settings.quota.enabled=false 时缺席（R11）。 */
  quota?: QuotaService;
  /**
   * 外部 agent 端口（external-agent plan §5.5，P5）：externalAgents.droid.enabled 时
   * 存在；index.ts 的 session_shutdown 经它 dispose（停目录探测；不杀运行中的 run）。
   */
  external?: ExternalAgentsPort;
  /** turn_end 注入的会话级闩锁状态；与 quota 同生共死（M3：dispose 的唯一所有者是 QuotaService）。 */
  quotaHint?: QuotaHintState;
  /** sysload activation and admission surface; absent when load.enabled is false. */
  load?: LoadActivation;
  loadAdmission?: LoadAdmission;
  loadTransition?(): { gateCleared: boolean; provenRecovered: boolean; escalatedTo?: "warn" | "crit" } | undefined;
  refreshLoadStatus(): void;
  loadHintState?: LoadHintState;
  /** /goal 目标驱动持续运行的 session 级运行态（goal-plan v4）。无持久 timer，纯数据。 */
  goal: GoalSession;
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
  /**
   * child-bash no-host-view diag plan (L1 todo #20): releases this stack's
   * "host-view" capability declaration on the process-global
   * `ChildBashRegistry`. Dual-path teardown, same discipline as
   * `worktreeOrphansStartup` — the top of the NEXT `buildSessionStack`
   * releases it (same-module rebuild) AND index.ts's `session_shutdown`
   * disposes it directly (covers `/reload`, which resets the module-level
   * handoff variable). Idempotent (release-once), so both paths firing is
   * always safe.
   */
  hostBashViewCapability: { dispose(): void };
  /**
   * ask-user-async plan §3.2/§3.3 (P2): the background-completion hub — the
   * provider half of the §3.1 AskUserBackgroundPort (P1's ask-user half
   * subscribes via `holder.current?.backgroundCompletions`). Always
   * constructed, even when askUser.backgroundInterrupt.enabled=false (the
   * consumer-side gate is P1's). Teardown has THREE idempotent paths: the
   * very top of the next buildSessionStack (before the old coalescer/bash
   * manager), index.ts's session_start defensive block, and the first line
   * of session_shutdown.
   */
  backgroundCompletions: BackgroundCompletionHub;
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

/**
 * TUI-safe warning sink. In interactive TUI mode a raw `console.warn` writes
 * straight to the terminal and corrupts pi's layout (seen with the droid quota
 * adapter's "invalid FACTORY_API_KEY" warning), so with a UI the message goes
 * through `ctx.ui.notify`; print/json/child sessions (no UI) keep stderr.
 * Never throws: a stale ctx falls back to console.warn.
 *
 * The `[pi-subagent]` tag is a stderr-only source marker (raw stderr mixes output from many
 * sources); a TUI notify is already attributed by pi's own `Warning:` chrome and every message
 * routed here names its subsystem (`[quota] …`, `bash job …`, droid …), so the UI copy drops it.
 */
export function hostWarn(ctx: ExtensionContext, message: string): void {
  try {
    if (ctx.hasUI && ctx.ui && typeof ctx.ui.notify === "function") {
      ctx.ui.notify(message, "warning");
      return;
    }
  } catch {
    // stale ctx / ui not ready — fall through to stderr
  }
  console.warn(`[pi-subagent] ${message}`);
}

function rankLoadLevel(level: string): number {
  return level === "crit" ? 2 : level === "warn" ? 1 : level === "ok" ? 0 : -1;
}

function safeSetLoadStatus(ctx: ExtensionContext, port: LoadPort | undefined, enabled: boolean): void {
  try {
    if (!enabled || !port || !ctx.ui || typeof ctx.ui.setStatus !== "function") return;
    const verdict = port.verdict();
    ctx.ui.setStatus("load", `load ${verdict.level}${verdict.gating ? " · gated" : " · open"}`);
  } catch {
    // stale/headless UI is deliberately inert.
  }
}

/**
 * external-agent plan §5.5（P5）：index.ts 传给 buildSessionStack 的外部 agent跨接线。
 * `memoryBlock` 是 wireMemory 返回的 renderForExternal 经 holder 晚绑定的入口（memory
 * 关闭时 index.ts 不传）；是否注入由 settings.externalAgents.droid.{enabled,injectMemory}
 * 决定（在 buildSessionStack 内判定，保持关闭态零接线）。
 */
export interface StackExternalInput {
  memoryBlock?: (cwd: string) => string | undefined;
}

export function buildSessionStack(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settings: AgentSettings,
  types: AgentTypeRegistry,
  mergedExtensions: readonly SubagentExtensionPoints[],
  /** /goal 读回口径（v4 条件 8）需要 session_start 的 reason；默认 "reload"（静默读回）。 */
  sessionReason: GoalSessionStartReason = "reload",
  loadHintState?: LoadHintState,
  externalInput?: StackExternalInput,
  xsInput: StackXsInput = {},
  /** scheduled-reports A0: activate-level wiring (present ⇔ schedule.enabled). */
  scheduleWiring?: ScheduleWiring,
  /** #54: the activate-time settings-file report; its notices are surfaced once, on the first stack build. */
  settingsFile?: SettingsFileReport,
): Stack {
  // settings-rename plan §3.8: S6b conflict / ignored relative PI_CODING_AGENT_DIR reach the user through the
  // existing session_start path (no new pi.on registration). Once per activation: the flag lives on the report,
  // which is owned by the activate closure (I4). Headless modes already got the console.warn at activate time.
  if (settingsFile !== undefined && !settingsFile.notified) {
    settingsFile.notified = true;
    if (ctx.hasUI) {
      for (const notice of settingsFile.notices) {
        try {
          ctx.ui.notify(notice, "warning");
        } catch {
          // stale ctx / ui not ready — the console.warn at activate time already told the user
        }
      }
    }
  }
  // Path A (src/stack-teardown.ts REBUILD_STEPS): tear down what the previous build in this module left behind, in the
  // order of §4.2 column A (backgroundCompletions before the old coalescer/bash manager: ask-user-async §3.3 (P2)).
  // `parts` is this build's own slot set, published as `previousParts` immediately and filled INCREMENTALLY below at the
  // places the components are created — a build that throws half-way still leaves its already-created components
  // for the next build's handoff. Assigned only after the handoff succeeded: if a step throws, the same (partially
  // cleared) parts are retried by the next build.
  const { prevBashJobs } = runRebuildHandoff(previousParts);
  const parts: TeardownParts = {};
  previousParts = parts;

  if (loadHintState !== undefined) {
    loadHintState.latches.clear();
    loadHintState.lastSentAt = 0;
    loadHintState.hasSent = false;
    loadHintState.recoveryPending = false;
    loadHintState.rejectedSinceRecovery = false;
  }
  const load = settings.load.enabled ? createLoadActivation({ settings: settings.load }) : undefined;
  load?.start({ mode: ctx.mode, ...(process.env.HOME === undefined ? {} : { home: process.env.HOME }), cwd: ctx.cwd });
  const loadPort = load?.port();
  const loadListeners = new Set<() => void>();
  let lastLoadGating = loadPort?.verdict().gating ?? false;
  let lastLoadLevel = loadPort?.verdict().level ?? "unknown";
  const loadTransition = loadPort
    ? () => {
        const verdict = loadPort.verdict();
        const gateCleared = lastLoadGating && !verdict.gating;
        const provenRecovered =
          lastLoadGating && !verdict.gating && verdict.level !== "unknown" && verdict.level !== settings.load.gateLevel;
        const escalatedTo =
          verdict.level === "warn" || verdict.level === "crit"
            ? rankLoadLevel(verdict.level) > rankLoadLevel(lastLoadLevel)
              ? verdict.level
              : undefined
            : undefined;
        lastLoadGating = verdict.gating;
        lastLoadLevel = verdict.level;
        if (gateCleared) for (const listener of loadListeners) listener();
        return { gateCleared, provenRecovered, ...(escalatedTo === undefined ? {} : { escalatedTo }) };
      }
    : undefined;
  const loadAdmission: LoadAdmission | undefined = loadPort
    ? {
        blocked: () => {
          const gating = loadBlocked(loadPort);
          if (lastLoadGating && !gating) for (const listener of loadListeners) listener();
          lastLoadGating = gating;
          return gating;
        },
        onGateCleared: (fn) => {
          loadListeners.add(fn);
          return () => loadListeners.delete(fn);
        },
      }
    : undefined;
  const loadGate = loadPort
    ? ({ nested }: { nested: boolean }): { message: string } | undefined => {
        const verdict = loadPort.verdict();
        const top = loadPort.top();
        const ownRuns = query
          ?.list()
          .filter((s) => s.status === "running")
          .map((s) => s.diag.label ?? s.runId);
        const decision = evaluateLoadGate(verdict, settings.load, {
          nested,
          ...(top === undefined ? {} : { top }),
          ...(ownRuns === undefined ? {} : { ownRuns }),
        });
        if (decision.blocked && decision.message !== undefined) {
          if (!nested && loadHintState !== undefined) loadHintState.rejectedSinceRecovery = true;
          loadPort.refreshTop();
          return { message: decision.message };
        }
        return undefined;
      }
    : undefined;

  // ask-user-async plan §3.2/§3.3 (P2): the background-completion hub. Built
  // unconditionally — when askUser.backgroundInterrupt.enabled=false the port
  // simply has no subscribers (the consumer-side gate is P1's); the three
  // send points below keep byte-identical pi.sendMessage semantics, the hub
  // only adds bookkeeping + broadcast on top. `isStreaming` is sampled per
  // send (A1/C8); `ctx.isIdle` missing (older pi) degrades to "never
  // streaming" = no tokens, no interrupts — the safe direction.
  const backgroundCompletions = createBackgroundCompletionHub({
    isStreaming: () => typeof ctx.isIdle === "function" && !ctx.isIdle(),
    now: () => systemClock.now(),
  });
  parts.backgroundCompletions = backgroundCompletions;
  const sendCompletion = backgroundCompletions.createSender((message, options) => pi.sendMessage(message, options));

  // Legacy consult fork-copy GC (#40): the consult tool is gone, but older versions left fork copies under
  // `consult-sessions`. Once per session build, no timer; drains them via the 24h TTL + headerless-fragment
  // rule (runtime/legacy-consult-forks.ts). Never throws; a missing dir is a no-op.
  sweepLegacyConsultForks();

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
  // G5a 补全（2026-10-04 事故）：把会话文件里的终态 run 快照种回内存 store，
  // 否则进程重启后 resume/候选列表全空（条目明明还在盘上）。种 base 不种
  // 写穿包装，避免旧条目被重复 appendEntry。
  const baseStore = new MemoryRunStore();
  if (readBack) seedRunStoreFromEntries(baseStore, prefetchedEntries);
  const runLog = readBack ? wrapWithRunLog(baseStore, runLogHost) : undefined;
  const store = runLog ?? baseStore;
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
  // fabric-cross-session plan §4.5 (W5): the tombstone index is shared with the wake service, which reads a run's
  // `wakeExclusion`/`wakeLevel` from it once the snapshot is gone. Same default TTL/clock as SpawnService's own.
  const tombstones = new TombstoneStore();
  // quota-plan §4.1 / integration-map §7：spawn 闸门（下方 createSpawnService）
  // 需要 quota，而 quota 按计划构造在 keepalive 之后——晚绑定 ref
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
    ? buildFabric(
        pi,
        ctx,
        settings,
        prefetchedEntries,
        readBack,
        runnerRef,
        () => query,
        () => spawnRef.current,
        {
          tombstone: (runId) => tombstones.get(runId),
          agentTypeExists: (name) => types.get(name) !== undefined,
        },
      )
    : undefined;
  if (fabric) parts.fabricMailbox = fabric.mailbox;
  const sendFormatted = (items: readonly DeliveryPayload[]): void => {
    // fabric-cross-session plan §3.7 (W6): a wake-revived run's completion is QUIET — it reaches the owner's context
    // without a turn and without the background-completion hub (no token, no broadcast ⇒ an active ask_user dialog,
    // TUI or RPC/web, is never interrupted or deferred). A mixed digest splits into two sends. Quiet goes first: if
    // it throws nothing has been sent yet (the notifier retries the whole batch cleanly); if the normal half throws
    // afterwards the retry can only repeat a silent notice, never lose a loud one.
    if (items.some((item) => item.quiet === true) && items.some((item) => item.quiet !== true)) {
      sendFormatted(items.filter((item) => item.quiet === true));
      sendFormatted(items.filter((item) => item.quiet !== true));
      return;
    }
    const quiet = items.length > 0 && items[0]!.quiet === true;
    const send: SendCompletion = quiet
      ? (_kind, message) => pi.sendMessage(message, { triggerTurn: false })
      : sendCompletion;
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
      // ask-user-async §3.3 (P2): the REAL single-run completion send point —
      // coalescer/ackHold/caller-ack suppression all happen before this, so
      // the interrupt inherits every existing suppression rule for free.
      send(
        "subagent",
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
    send(
      "subagent",
      {
        customType: "subagent:notification",
        content: formatDigest(items, { stats }),
        display: true,
        details: { ...first, kind: "digest", items },
      },
      { triggerTurn: true },
      // §3.4: a digest mints ONE token carrying the item count.
      items.length,
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
  parts.coalescer = coalescer;
  parts.ackHold = ackHold;
  // X3: lazy ref — nested Agent tool + abort-cascade need SpawnService, built just below.
  // M-D: runIds whose "subagent:started" event has already been emitted (once per run).
  const announcedStarts = new Set<string>();
  // ── 外部 agent 端口（external-agent plan §5.5，P5）──
  // enabled=false ⇒ createExternalAgentsPort 返回 undefined ⇒ 下方一切 external 注入
  // 缺席，driver 仍是纯 PiSessionDriver（关闭态零接线、零行为变化，R10 回滚①）。
  // 构造点在 models/driver 之前：resolveHint 包装与 RoutingSessionDriver 都消费它。
  const externalWarned = new Set<string>();
  const externalPort = createExternalAgentsPort({
    settings: settings.externalAgents,
    agentDir: getAgentDir(),
    clock: systemClock,
    registry: () => {
      try {
        return ctx.modelRegistry.getAll().map((m) => ({
          provider: m.provider,
          id: m.id,
          ...(m.cost ? { cost: m.cost } : {}),
        }));
      } catch {
        return undefined; // 被替换会话上的陈旧注册表 ⇒ fail-open（定价退化 unpriced）
      }
    },
    piProviders: () => {
      try {
        return ctx.modelRegistry.getAvailable().map((m) => m.provider);
      } catch {
        return [];
      }
    },
    ...(settings.externalAgents.droid.enabled &&
    settings.externalAgents.droid.injectMemory &&
    externalInput?.memoryBlock !== undefined
      ? { memoryBlock: externalInput.memoryBlock }
      : {}),
    // Really once per key (the key used to be ignored ⇒ one warning per run), and TUI-safe.
    warnOnce: (key, message) => {
      if (externalWarned.has(key)) return;
      externalWarned.add(key);
      hostWarn(ctx, message);
    },
  });
  if (externalPort !== undefined) {
    parts.external = externalPort.port;
    // §4.7：构建期后台目录探测（single-flight、有界、unref、失败静默）。
    externalPort.providers.get("droid")?.catalog.refreshInBackground("stack_build");
  }
  // quota-plan r2 §4 接线清单 1：droid 池端口（与 quota stack 的输入同源；getter 晚绑定
  // 到 providers/catalog/settings）。构造后立即 warm()——把目录缓存首次 ≤256KiB 的同步读
  // 挪到 stack 构建阶段，避开首个 droid spawn 的闸门判定；与上面的 refreshInBackground
  // 相邻（目录缓存不存在时是空操作，首探由后台探测补）。端口缺席 ⇒ undefined ⇒ 零接线。
  const droidPoolPort: CatalogPoolPort | undefined =
    externalPort !== undefined
      ? createCatalogPoolPort({
          provider: "droid",
          catalog: () => externalPort.providers.get("droid")?.catalog.snapshot(),
          preferred: () => settings.externalAgents.droid.models,
        })
      : undefined;
  droidPoolPort?.warm();
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
    resolveHint: (hint) => {
      // external-agent plan §5.4 (P5)：严格 provider/id 且是外部 provider ⇒ 直接返回
      //（fuzzy hint 永不落到 droid）；端口缺席 ⇒ 原函数（字节一致）。
      if (externalPort !== undefined) {
        const strict = parseStrictModelRef(hint);
        if (strict !== undefined && externalPort.port.owns(strict.provider)) return strict;
      }
      return resolveModelHint(
        hint,
        ctx.modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id, name: m.name })),
      );
    },
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
  // bash-timeout-grace plan §3.1-3.3 (P5): the process-global registry the
  // child (subagent) session's own bash job manager registers into
  // (src/bash/child.ts). `query` is referenced by closures below that only
  // ever run later (async, once a real run exists) — by then it holds the
  // value assigned further down in this same function (same forward-
  // reference pattern as spawnRef above).
  const childBashRegistry = getChildBashRegistry();
  // L1 todo #20: this stack really does run the `attachHost` wiring below
  // (`onSessionSeen`) — declare it once, released at the top of the NEXT
  // build (module-level handoff above) and by index.ts's session_shutdown
  // (the `/reload` fresh-module case).
  const hostBashViewCapabilityRelease = declareHostBashViewCapability(childBashRegistry);
  parts.hostBashViewRelease = hostBashViewCapabilityRelease;
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
    // external-agent plan §5.5 (P5)：端口存在 ⇒ RoutingSessionDriver 按 spec.external 分派
    // 外部 run，其余原样委托 pi driver；缺席 ⇒ 纯 PiSessionDriver（与改动前一致）。
    driver: (() => {
      const piDriver = new PiSessionDriver(settings.rememberAgents, (p, id) => ctx.modelRegistry.find(p, id));
      return externalPort !== undefined ? new RoutingSessionDriver(piDriver, externalPort.providers) : piDriver;
    })(),
    ...(externalPort !== undefined
      ? {
          external: externalPort.port,
          // §15 跟踪项 1（P4b 验收遗留）：planRun 的 persist 与 PiSessionDriver 的
          // `?? rememberAgents` 口径对齐——rememberAgents=false 时未显式 persist 的
          // droid run 也不写 transcript。
          externalPersistDefault: settings.rememberAgents,
        }
      : {}),
    pool,
    store,
    watchdog,
    reaper,
    notifier,
    // run-persistence plan D2: non-terminal journal entries go straight to the
    // session log (never the in-memory store, J1). readBack=false ⇒ absent,
    // journaling off — same degradation as the run-log itself.
    ...(runLog ? { journal: (snapshot: RunSnapshot) => runLog.journal(snapshot) } : {}),
    ...(fabric
      ? {
          fabric: {
            router: fabric.router,
            ...(fabric.level ? { wake: { levelOf: (node: NodeRef) => fabric.level!.levelOf(node) } } : {}),
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
    onReaped: (runId, sessionId) => {
      fabric?.wake?.onReaped(runId);
      // bash-timeout-grace plan §3.2 (P5): defensive fan-out — `sealAndKill`
      // is idempotent, so this is a no-op for the (normal) case where
      // `sealBeforeTerminal` already sealed the session; it only matters for
      // the two late-arrival paths (E18), which never had a chance to run
      // through the runner's own `sealBeforeTerminal` first.
      if (sessionId !== undefined) {
        childBashRegistry.sealAndKill(sessionId, BASH_JOB_SEAL_GRACE_MS, runId);
        // child-context-switch plan.md §2.4 终态 ③ (P3): same defensive fan-out — the child's own
        // agent_settled path (src/cache-ttl/child.ts) already disposes its keepalive service in
        // the normal case; this only matters when that path was somehow never taken. P1 review
        // fix (todo #30 follow-up): pass this call's own runId through so a resumed run's fresher
        // registration (a different runId, see child.ts's register()) is never disposed by an old
        // run's late-arriving onReaped fan-out.
        getChildKeepaliveDisposeRegistry().disposeSession(sessionId, runId);
      }
    },
    sealSession: (runId, sessionId) => childBashRegistry.sealAndKill(sessionId, BASH_JOB_SEAL_GRACE_MS, runId)?.facts,
    onSessionSeen: (runId, sessionId) => {
      childBashRegistry.attachHost(sessionId, hostViewFor(runId));
      // §3.6 boundary telemetry: correlate any pending noteToolReturn calls
      // against this run's tool history once it is observable.
      checkBashToolReturnLag(pendingToolReturns, warnedToolLag, query.get(runId)?.diag.toolHistory, (message) =>
        console.warn(`[pi-subagent] ${message}`),
      );
    },
    childBashJobsEnabled: settings.bashJobs.childSessions,
    // child-context-switch plan.md §4/§7 (P3): live read — recomputed on every spawn admission so
    // a process-wide capability disablement (src/context-switch/capability.ts) mid-session stops
    // future grants immediately, without needing a new stack build.
    childSwitchContextGrant: () => resolveChildSwitchContextGrant(settings),
    ...(loadGate ? { loadGate: () => loadPort?.verdict().gating === true } : {}),
  });
  runnerRef.current = runner; // M4: 接通 watchdog 的晚绑定
  const spawn = createSpawnService({
    types,
    pool,
    tombstones,
    runner,
    // external-agent plan §5.1/§5.5（P4b/P5）：端口存在时注入 external 准入门 + agentDir
    //（结构性外部会话判定用）；缺席 ⇒ 既有行为（droid/x 走原 unknown-model 文案）。
    ...(externalPort !== undefined ? { external: externalPort.port, agentDir: getAgentDir() } : {}),
    budget: settings.budget,
    maxNestedDepth: settings.maxNestedDepth,
    // G5a 补全：resume/get_result 的解析器 records 源接持久 store（重启后由
    // pi-run-log 种子恢复），不再只看本进程生命周期的内存 Map。
    durableRecords: () => store.list(),
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
    ...(loadGate ? { loadGate } : {}),
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
              // droid 池闸门（quota-plan r2 §9）：droid 适配器未构造时
              // verdictsForModel 恒返回 undefined ⇒ 走旧路径（字节不变）。
              modelView: (m) => quota.service.verdictsForModel(m),
              poolAlternatives: (b) => quota.service.poolAlternatives(b),
              // pi provider 被拦时的补充候选（2026-10-15 拍板）：端口/适配器未构造
              // ⇒ 恒 [] ⇒ 闸门文案字节不变。
              droidAlternatives: () => quota.service.droidAlternatives(),
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
    ...(fabric?.wake ? { inbox: fabric.wake } : {}),
    // fabric-cross-session plan §3.3 L4 (W1): spawn admission reads causal levels only with wake on.
    ...(fabric?.level
      ? {
          causal: {
            levelOfRun: (runId: RunId) => fabric.level!.levelOf(runId),
            root: () => fabric.level!.root,
          },
        }
      : {}),
    onOutcomeAcked: (outcome) => {
      try {
        notifier.ack(outcome.runId, outcome.diag.generation, { extensionOwner: "spawnAndWait" });
      } catch {
        // Best effort only.
      }
    },
    notifyTerminalFailure: (outcome, opts) => {
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
        // W6: a wake-revived run that fails before any snapshot is still reported quietly (plan §3.7).
        ...(opts?.quiet ? { quiet: true as const } : {}),
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
        fabric.wake?.onSnapshot(snapshot);
        if (snapshot.status === "running") {
          fabric.tree.markRunning(snapshot.runId);
          // W4: waiters of this run's session chain (messages addressed to its finished predecessors) now redirect-steer.
          if (fabric.wake) fabric.mailbox.drainSession(snapshot.diag.sessionFile, snapshot.runId);
          else fabric.mailbox.pump(snapshot.runId);
        }
        if (["completed", "failed", "timed_out", "aborted"].includes(snapshot.status))
          fabric.mailbox.onRunSettled(snapshot.runId);
      }
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
      pi.appendEntry(WORKTREE_DISPOSITION_CUSTOM_TYPE, entry);
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
  parts.worktreeLate = worktreeLate;
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
  // `buildSessionStack` (the `worktreeOrphansStartup` rebuild-handoff step, same-module rebuild)
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
  parts.worktreeOrphansStartup = worktreeOrphansStartup;
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
    // fabric-cross-session plan §3.3 seam B (W1): steer_subagent / web steer / @mention propagate their origin level.
    ...(fabric?.level ? { onSteered: (runId, originLevel) => fabric.level!.onSteered(runId, originLevel) } : {}),
  });
  // W3: hydrate/reconcile before any mailbox pump; query is now a live registry, not a raw journal.
  fabric?.wake?.reconcile();
  // M9: created early — the fleet widget below lists in-flight workflows.
  const workflowActivity = createWorkflowActivityRegistry();
  // M-E: live usage broadcaster (channel "subagent:usage", 1Hz while active).
  const usageBroadcaster = new UsageBroadcaster({
    list: () => query.list(),
    emit: (event) => pi.events.emit("subagent:usage", event),
    clock: systemClock,
  });
  usageRef.current = usageBroadcaster;
  parts.usageBroadcaster = usageBroadcaster;
  // D5: build the manager before the widget so its synchronous first frame can
  // receive the manager-bound list/tail closures below.
  // 2026-10-17 shell-resolution revision: pi's `shellPath`/
  // `shellCommandPrefix` are read once per stack build (session_start,
  // non-live) — `bashShell` reaches index.ts's tool registration for the
  // prefix, and `piShellPath` feeds every process port below.
  const piShell = readPiShellSettings(ctx.cwd);
  const bashJobs = bashJobsEnabled(settings)
    ? buildBashJobManager(pi, ctx, settings, (message, options) => sendCompletion("bash", message, options), piShell)
    : undefined;
  parts.bashJobs = bashJobs;

  // web-hub archive plan (docs/dev/web-hub/archive-report.md): per-session archive control —
  // seeded from the branch's last `subagent:archive` entry (the G5a read-back discipline),
  // swept every 60s while `webHub.archiveAfterMin` > 0. Gated on webHub.enabled (the whole
  // feature is web-originated; with web-hub off nothing is ever archived and the TUI widget's
  // filter getter stays absent — byte-identical rendering).
  const archive = settings.webHub.enabled
    ? new ArchiveControl(
        { runs: () => query.list(), bashJobs: () => bashJobs?.list() ?? [] },
        { appendEntry: (type, data) => pi.appendEntry(type, data), now: () => systemClock.now() },
      )
    : undefined;
  if (archive !== undefined) {
    const archiveBranch = readBack
      ? ((ctx.sessionManager as unknown as { getBranch?: () => readonly unknown[] }).getBranch?.() ?? [])
      : [];
    archive.restore(archiveBranch);
    archive.start(
      Math.max(0, settings.webHub.archiveAfterMin ?? 30) * 60_000,
      settings.webHub.archiveKeepRuns ?? 6,
      settings.webHub.archiveKeepBash ?? 5,
    );
  }
  parts.archive = archive;

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
        isCurrent: (self) => parts.keepalive === self,
        appendEntry: (type, data) => pi.appendEntry(type, data),
        emit: (channel, payload) => pi.events.emit(channel, payload),
        // Keepalive breaker state is session-level; restore it from this branch
        // across /reload while deliberately rebuilding window/prefix state fresh.
        restoredState: readBack
          ? readBackKeepaliveSessionState(
              (ctx.sessionManager as { getBranch?: () => readonly unknown[] }).getBranch?.() ?? [],
            )
          : undefined,
        recoverTransientFailures: true,
        persistSessionState: true,
        // O2/O3 (provider-evidence, 2026-10-12): route-level TTL evidence + the
        // no-cache-value breaker. Process-wide singleton — shared with child keepalives.
        evidence: getProviderEvidenceStore(),
      })
    : undefined;
  parts.keepalive = keepalive;

  // quota（quota-plan §4.1）：额度感知派单——与 keepalive 同款可选构造 +
  // previous* 交接。构造零副作用（demotion store 惰性加载）；providers="" 时
  // 零 adapter ⇒ 零网络（测试隔离位）。
  const quota = settings.quota.enabled
    ? createQuotaStack({
        settings: settings.quota,
        clock: systemClock,
        statePath: join(getAgentDir(), "quota-state.json"),
        // quota-plan r2 §4 接线清单 1（P5）：droid 池输入——外部端口存在时供给
        //（getter 晚绑定）；缺席 ⇒ 不构造 droid 适配器（零网络/零凭据/零告警，D11）。
        ...(droidPoolPort !== undefined
          ? {
              droid: {
                pools: (): QuotaPoolPort => droidPoolPort,
                // Late-bound billing evidence only: keep polling while unavailable, but a successful
                // billing response must never clear CLI run/catalog authentication failures.
                onAvailability: (problem: QuotaProblem | undefined) =>
                  externalPort?.port.observeAvailability?.(
                    "droid",
                    problem === undefined
                      ? { source: "quota", ok: true }
                      : { source: "quota", authError: `Factory HTTP ${problem.status}` },
                  ),
              },
            }
          : {}),
        ...(settings.quota.hud
          ? {
              setStatus: (text: string | undefined) => safeSetQuotaStatus(ctx, text),
              theme: () => readQuotaStatusTheme(ctx),
            }
          : {}),
        warn: (message) => hostWarn(ctx, message),
      })
    : undefined;
  parts.quota = quota;
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
      // web-hub archive plan: display-only hiding of archived runs/bash rows in the TUI
      // widget (same 1Hz tick re-reads the view — no extra refresh wiring needed).
      ...(archive ? { archived: () => archive.view() } : {}),
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
    parts.fleetWidget = widget;
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
  const schedule = scheduleWiring?.createAgent({ ctx });
  // scheduled-reports I1: the `message` (A2) and `background` (A1) executors, BEFORE `schedule.start()` (index.ts).
  const scheduleBackground =
    schedule !== undefined
      ? installScheduleExecutors(pi, ctx, schedule, {
          message: scheduleWiring?.message,
          spawn,
        })
      : undefined;
  const rpc = createRPCServer({ events: pi.events, spawn, query });
  // §3.6: prepare the session directory before recover so migrated/orphaned
  // records enter the normal adjudication and notification path.
  let bashJobRecovery: { dispose(): void } | undefined;
  if (bashJobs) {
    const rootDir = settings.bashJobs.dir ?? join(getAgentDir(), "bash-jobs");
    const selfDirName = sanitizeSessionDirName(currentSessionId(ctx));
    const processPort = createProcessPort({
      ...(settings.bashJobs.shellPath !== undefined ? { shellPath: settings.bashJobs.shellPath } : {}),
      ...(piShell.shellPath !== undefined ? { piShellPath: piShell.shellPath } : {}),
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
      warn: (message: string) => hostWarn(ctx, message),
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
      warn: (message) => hostWarn(ctx, message),
    });
  }
  parts.bashJobRecovery = bashJobRecovery;

  // M3.6 (CC3, §11 M3.6): the workflow engine's session-lifetime pieces —
  // built unconditionally (cheap: a spawner adapter closure + a budget
  // object + an empty activity map), but `workflow.enabled` gates whether
  // `index.ts` ever registers the `SubagentWorkflow` tool that would
  // actually call `createOrchestrator()` (settings.workflow.enabled default
  // `false` — the engine stays entirely inert until then).
  // (M9: created above the fleet widget, which lists in-flight workflows.)
  const workflowChildSpawner = createWorkflowChildSpawner(spawn, types, {
    ...(loadAdmission ? { loadAdmission } : {}),
    // workflow-worktree plan D2: read fresh on every call (not snapshotted
    // at stack-build time) so a `/reload` that flips `worktree.enabled`
    // takes effect for the next agent({isolation}) call immediately.
    // data-encryption D2: workflow isolation is unavailable outside the plain domain.
    worktreeAvailable: () => settings.worktree.enabled && (getSecureDomain()?.kind ?? "plain") === "plain",
    // replay-verify plan D9: same freshness convention — a `/reload` that
    // flips `workflow.isolationReplay` only takes effect for the NEXT run's
    // own `buildJournalConfig` (pinned once per run), not a run already live.
    isolationReplayMode: () => settings.workflow.isolationReplay,
    // D4.1: the cwd H2 falls back to when a request carries no explicit
    // `cwd` (`worktree.ts`'s `resolve(spec.cwd ?? request.cwd ?? process.cwd())`)
    // — pinned once per run by `buildJournalConfig`, read here fresh each time.
    isolationCwd: () => process.cwd(),
    // D4.2/D4.4: a single bounded `git for-each-ref` over already
    // regex-validated `pi-agent-*` branch names — the AbortSignal comes from
    // `runBoundedProbe`'s own timer (workflow/isolation-verify.ts), so this
    // adapter only needs to forward it into `pi.exec`'s own cancellation.
    probeAgentBranches: async (branches, opts) => {
      try {
        const result = await pi.exec(
          "git",
          ["for-each-ref", "--format=%(refname) %(objectname)", ...branches.map((b) => `refs/heads/${b}`)],
          { cwd: opts.cwd, timeout: opts.timeoutMs, signal: opts.signal },
        );
        if (result.code !== 0 || result.killed) {
          return { ok: false, error: result.stderr.trim() || `git for-each-ref exited ${result.code}` };
        }
        return { ok: true, tips: parseForEachRef(result.stdout, new Set(branches.map((b) => `refs/heads/${b}`))) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
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
      // replay-verify plan D4.3: `min(worktree.gitTimeoutMs, 5_000)`, kept
      // decoupled from orchestrator.ts (WI2 — it only sees a plain number).
      isolationVerifyTimeoutMs: Math.min(settings.worktree.gitTimeoutMs, 5_000),
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
      // ask-user-async §3.3 (P2): the workflow completion send point. The sink
      // DEPENDS on a synchronous throw to fall back to persisted re-delivery
      // (workflow-notice.ts) — sendCompletion propagates it untouched. The
      // re-delivery path below (`redeliverPendingWorkflowNotices`) keeps raw
      // pi.sendMessage: a re-send is not a fresh completion and must not mint.
      sendMessage: (message, options) => sendCompletion("workflow", message, options),
      appendEntry: (customType, data) => pi.appendEntry(customType, data),
      emit: (channel, payload) => pi.events.emit(channel, payload),
      usageOf: (runId) => query.get(runId)?.diag.usage,
      resultMaxChars: () => settings.resultMaxChars,
      now: () => systemClock.now(),
    }),
  });
  parts.workflowRuns = workflowRuns;
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
  const xs = xsOn({
    fabric: settings.fabric,
    webHub: { enabled: settings.webHub.enabled, control: settings.webHub.control !== false },
  })
    ? buildStackXs(pi, ctx, settings, sessionReason, fabric?.level, xsInput)
    : undefined;
  // Disabling xs/wake does not erase already-dispatched ownership (XI2/B1). Never admit a
  // new wake here: revoke unexecuted tokens; retain watchdog/abort/hand-over for real runs.
  const ledger = getXsWakeLedger();
  const pendingRootWakes = ledger.entries().filter((r) => r.sessionId === ctx.sessionManager.getSessionId());
  let rootWakeRecovery: RootWakeController | undefined;
  if (!xs?.controller && pendingRootWakes.length > 0) {
    for (const record of pendingRootWakes) {
      if (!record.started && !record.executionPending) ledger.tombstone(record.token);
    }
    rootWakeRecovery = new RootWakeController({
      sessionId: ctx.sessionManager.getSessionId(),
      rootRunMaxS: settings.fabric.wake.rootRunMaxS,
      wakeEnabled: false,
      receive: () => "off",
      ledger,
      host: {
        isIdle: () => (typeof ctx.isIdle === "function" ? ctx.isIdle() : true),
        hasPendingMessages: () => (typeof ctx.hasPendingMessages === "function" ? ctx.hasPendingMessages() : false),
        sendMessage: (message, options) => pi.sendMessage(message, options),
        abort: () => {
          if (typeof ctx.abort === "function") ctx.abort();
        },
      },
      ...(fabric?.level ? { level: fabric.level } : {}),
      audit: (event) => console.warn(`[pi-subagent] fabric xs ${event}`),
    });
    rootWakeRecovery.recover();
  }
  parts.rootWakeRecovery = rootWakeRecovery;
  parts.xs = xs;
  const stack: Stack = {
    dispose: ((entry: StackTeardownEntry, env?: StackTeardownEnv) =>
      entry.kind === "rebuild-handoff"
        ? void runRebuildHandoff(parts)
        : runStackTeardown(entry as never, stack, env as StackTeardownEnv, parts)) as Stack["dispose"],
    disposeXsSync: () => disposeXsSync(stack),
    ...(xs ? { xs } : {}),
    ...(rootWakeRecovery ? { rootWakeRecovery } : {}),
    compactHint,
    ...(dynamic ? { dynamic } : {}),
    ...(load ? { load } : {}),
    ...(loadAdmission ? { loadAdmission } : {}),
    ...(loadHintState ? { loadHintState } : {}),
    ...(loadTransition ? { loadTransition } : {}),
    refreshLoadStatus: () => {
      loadTransition?.();
      safeSetLoadStatus(ctx, loadPort, settings.load.hud);
    },
    models,
    spawn,
    query,
    runJournal: {
      flushPending: (runIds, shutdownReason) =>
        runner.flushJournal?.(runIds, { kind: "shutdown_flush", shutdownReason }) ?? 0,
    },
    contextReceipt,
    orphans: reaper.registry,
    notifier,
    mention,
    mentionNotes,
    ...(schedule !== undefined ? { schedule } : {}),
    ...(scheduleBackground !== undefined ? { scheduleBackground } : {}),
    rpc,
    workflow,
    goal,
    worktreeLate,
    worktreeOrphans,
    worktreeOrphansStartup,
    hostBashViewCapability: { dispose: hostBashViewCapabilityRelease },
    backgroundCompletions,
    ...(widgetRef.current ? { fleetWidget: widgetRef.current } : {}),
    ...(bashJobs ? { bashJobs, bashShell: piShell } : {}),
    ...(archive ? { archive } : {}),
    ...(bashJobRecovery ? { bashJobRecovery } : {}),
    ...(keepalive ? { keepalive } : {}),
    ...(quota ? { quota: quota.service, quotaHint: quota.hintState } : {}),
    ...(externalPort !== undefined ? { external: externalPort.port } : {}),
    ...(fabric ? { fabric: { dispose: () => fabric.mailbox.dispose(), pump: () => fabric.mailbox.pump() } } : {}),
    ...(fabric?.level && fabric.wake
      ? {
          wake: {
            level: fabric.level,
            status: (): WakeStatusView => ({
              maxLevel: fabric.level!.maxLevel,
              rootLevel: fabric.level!.root,
              resumesPerHour: settings.fabric.wake.resumesPerHour,
              durability: fabric.wake!.durability,
              ...fabric.wake!.stats(),
            }),
            inboxCount: (runId: string) => fabric.wake!.inboxCount(runId),
          },
        }
      : {}),
  };
  return stack;
}
