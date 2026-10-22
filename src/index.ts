import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { systemClock } from "./core/clock.js";
import { wireCacheTtl } from "./cache-ttl/cache-ttl.js";
import { getProviderEvidenceStore } from "./cache-ttl/provider-evidence.js";
import { MemoryOutboxStore, MemoryRunStore } from "./core/store.js";
import type { RunSnapshot, SpawnRequest, SubagentExtensionPoints, UsageDelta } from "./core/types.js";
import {
  assertCompatible,
  detectPiCapabilities,
  probeReadBackEntries,
  readBeforeAgentStartTrigger,
} from "./adapters/pi-compat.js";
import { createPiOutboxStore } from "./adapters/pi-outbox-store.js";
import { FABRIC_ENTRY_CUSTOM_TYPE, createFabricEntryRenderer } from "./adapters/fabric-entry-renderer.js";
import { wrapWithRunLog } from "./adapters/pi-run-log.js";
import { createAgentTypeRegistry } from "./config/agent-types.js";
import {
  defaultSettingsPath,
  loadSettingsFromFile,
  loadWebHubLanSettingsWarnings,
  loadWebHubProxyWarnings,
  persistSettingOverride,
  readSettingsNoMigrate,
  type AgentSettings,
} from "./config/settings.js";
import { createNotifier, type Notifier, type PersistedDelivery } from "./delivery/notifier.js";
import { mergeExtensionPoints } from "./extensions/registry.js";
import {
  buildSessionStack,
  bashJobsEnabled,
  BASH_JOB_SEAL_GRACE_MS,
  createCompactHintHook,
  createBackgroundCompletionEventHook,
  createNotificationReceiptHook,
  readBashJobTail,
  type Stack,
} from "./stack.js";
import { createMentionRouteDeps, installMentionInput } from "./mention/mention.js";
import { createWakeInputHook } from "./fabric/wake-input.js";
import { observeRootWakeTrigger } from "./fabric/root-wake.js";
import { getXsWakeLedger } from "./fabric/xs/wake-ledger.js";
import { getXsHostCapability } from "./fabric/xs/host-cap.js";
import { display as unreadDisplay, XS_INBOX_STATUS_KEY } from "./fabric/xs/unread.js";
import { xsOn } from "./fabric/xs/switch.js";
import { getXsReplyLedger } from "./fabric/xs/reply-ledger.js";
import { createXsSender, detectXsToolCollisions, type XsSender } from "./fabric/xs/sender.js";
import { createListSessionsTool, listSessionsParamsFor } from "./tools/list-sessions-tool.js";
import { createMessageChannelTool, MessageChannelParams } from "./tools/message-channel-tool.js";
import type { XsChannelView } from "./fabric/xs/types-channel.js";
import { currentConnection } from "./web-hub/agent/connection.js";
import { XS_CHANNEL_HUB_CAP } from "./web-hub/protocol/xs.js";
import { createMessageSessionTool, messageSessionParamsFor } from "./tools/message-session-tool.js";
import { createFabricXsCommand } from "./commands/fabric-xs.js";
import { aliasSuggestions } from "./fabric/xs/alias-suggest.js";
import type { XsHubLimitsWire } from "./web-hub/protocol/xs.js";
import { createMentionAutocompleteProvider, type MentionAutocompleteEntry } from "./mention/autocomplete.js";
import {
  SESSION_MENTION_ERROR_SOURCE,
  SESSION_MENTION_SENT_CUSTOM_TYPE,
  createMentionSessionPort,
  sessionCompletionBare,
  sessionCompletionAlias,
  type MentionSessionPort,
  type MentionSessionSendOutcome,
  type SessionMentionNotice,
} from "./mention/session.js";
import { createPiWorktreeExtension } from "./extensions/worktree.js";
import { worktreeRoot } from "./extensions/worktree-orphans.js";
import { EscalatingReaper, type OrphanRegistry } from "./runtime/reaper.js";
import { PiSessionDriver } from "./runtime/session-driver.js";
import { SingleSlotPool } from "./runtime/slot-pool.js";
import { EventWatchdog } from "./runtime/watchdog.js";
import { createQueryService, type QueryService } from "./service/query-service.js";
import { createRunRegistry } from "./service/run-registry.js";
import { createRuntimeRunnerAdapter } from "./service/runtime-adapter.js";
import { createSpawnService, type SpawnService } from "./service/spawn-service.js";
import { publishBackgroundStatus } from "./service/background-status.js";
import { createAgentTool } from "./tools/agent-tool.js";
import { createResultTool } from "./tools/result-tool.js";
import { createListSubagentsTool } from "./tools/list-subagents-tool.js";
import { createSteerTool } from "./tools/steer-tool.js";
import { createSetModelTool } from "./tools/set-model-tool.js";
import { createAbortTool } from "./tools/abort-tool.js";
import { createExtendTimeoutTool } from "./tools/extend-timeout-tool.js";
import { createCompactTool } from "./tools/compact-tool.js";
import { createSwitchContextTool } from "./tools/switch-context-tool.js";
import { PendingHandoffStore } from "./context-switch/store.js";
import { createQuotaHintHook } from "./quota/index.js";
import { parseSubscriptionProviders, pickAlternatives } from "./quota/gate.js";
import { createSwitchContextCompactHook } from "./context-switch/hook.js";
import { getChildSwitchCapability } from "./context-switch/capability.js";
import { createSessionFactsProvider } from "./context-switch/session-facts.js";
import { createSetCompactThresholdTool } from "./tools/set-compact-threshold-tool.js";
import { createBashTool } from "./tools/bash-tool.js";
import { createBashJobTool } from "./tools/bash-job-tool.js";
import type { BashJobManager } from "./bash/manager.js";
import { isTerminalJobStatus, type JobRecord } from "./bash/types.js";
import { createStatusCommand } from "./commands/status.js";
import { createWebHubCommand } from "./commands/webhub.js";
import { wireWebHub, type WebHubControl } from "./web-hub/agent/index.js";
import { renderXsMessage } from "./fabric/xs/render.js";
import { renderTaskStartedMessage, TASK_STARTED_CUSTOM_TYPE, createTaskCommand } from "./commands/task.js";
import { createGoalCommand } from "./goal/command.js";
import { createGoalLoopHook } from "./goal/hook.js";
import { persistGoalRecord } from "./goal/store.js";
import { createDisabledWorkflowToolStub, createWorkflowTool } from "./tools/workflow-tool.js";
import { registerWebSearchTool } from "./web-search/index.js";
import { wireDate } from "./date/index.js";
import { wireTodo } from "./todo/index.js";
import { wireMemory } from "./memory/index.js";
import type { TidySpawnRequest } from "./memory/contracts.js";
import { wireChildBashJobs } from "./bash/child.js";
import { wireChildSession } from "./child/wire.js";
import { markChildExtensionActivated } from "./child/activation-signal.js";
import { getChildBashRegistry } from "./bash/child-registry.js";
import { createPromptSectionHub } from "./sysprompt/hub.js";
import { agentTypesSection, availableModelsSection } from "./sysprompt/core-sections.js";
import { wireHud } from "./hud/index.js";
import wireAskUser from "./ask-user/index.js";
import { wrapCommandApi, type CommandCapturePort } from "./web-hub/agent/command-capture.js";
import type { ArgCompleter } from "./web-hub/agent/command-complete.js";
import wireFeishuNotify from "./feishu-notify/index.js";
import { wireSessionNav } from "./session-nav/index.js";
import { wireTitle } from "./title/index.js";
import { wireDeferredReload, type DeferredReloadDeps } from "./reload/index.js";
import { countActiveRuns, type DeferredReloadController } from "./reload/defer.js";
import type { WorkflowToolDeps } from "./tools/workflow-tool.js";
import type { AskUserRemotePort } from "./ask-user/remote.js";
import type { WorkflowQueryPort } from "./tools/workflow-target.js";
import { wireTopicSwitch } from "./topic-switch/wire.js";
import type { PromptGatePort } from "./web-hub/agent/prompt-gate.js";
import { createLoadHintHook, createLoadHintState } from "./sysload/hook.js";

/**
 * M2 Wave 1 (architecture §7.1): the single merge point for the four
 * documented extension hooks. Empty by default; future milestones (X1
 * worktree, X10 schema tools, etc.) push their SubagentExtensionPoints here
 * instead of inventing new mount points (I7: index.ts stays assembly-only).
 */
/** X1: worktree isolation (H2 rewrite cwd + H3 commit/remove). Default off; enable via settings worktree.enabled. Throws (→ failed(config)) when explicitly requested but unavailable — never silently falls back. */
function wireWorktree(pi: ExtensionAPI, settings: AgentSettings): SubagentExtensionPoints {
  return createPiWorktreeExtension(pi, settings.worktree);
}

/**
 * M1 assembly. Only wiring lives here (D7 / I7): register the three tools
 * and /agent status once, then (re)build the L2-L3 stack on every
 * session_start (ctx.sessionManager, needed for the G5a/G5b append-entry
 * read-back stores, is only available there — not on the module-load-time
 * ExtensionAPI). Tools close over a mutable holder so they always call
 * through to the current session's stack. session_shutdown drains bounded.
 */
export default function activate(rawPi: ExtensionAPI): void {
  const commandCaptureRef: { current?: CommandCapturePort } = {};
  // P1 fix (#32 C12 review): the set `wrapCommandApi`'s `registerCommand` proxy writes real
  // toolkit command names into, at real registration time — long before `commandCaptureRef.current`
  // is ever assigned (web-hub wiring runs last in this function). Handed to `createCommandCapture`
  // below by the same object reference, so `owns()`/`settleArm()` see every name registered so far
  // with no backfill step (see `command-capture.ts`'s doc comment above `createCommandCaptureEngine`).
  const ownedCommandNames = new Set<string>();
  // web-hub-slash-args plan §4.4 (P1): same by-reference pattern as `ownedCommandNames` above —
  // every toolkit command's RAW `getArgumentCompletions`, recorded by `wrapCommandApi`'s
  // registerCommand proxy at real registration time (long before web-hub wiring runs) and
  // read by the S-own completion source (`agent/command-complete.ts`) through the wireWebHub
  // deps. Created once per activate; NEVER module-scope (the /reload invariant).
  const argCompleters = new Map<string, ArgCompleter>();
  const pi = wrapCommandApi(rawPi, () => commandCaptureRef.current, ownedCommandNames, argCompleters);
  // Merged plugins (plugin-merge) that must stay available in EVERY session,
  // child subagent sessions included — they register BEFORE the HOST_KEY
  // guard below. Settings here come from the read-only loader: the full
  // loadSettingsFromFile migrates/writes the shared settings file, which must
  // never run concurrently from N child sessions (review B1). Visibility in a
  // child session is still subject to the agent type's `tools` allowlist
  // (tool-scope), and none of these names is in RESERVED_TOOL_NAMES.
  const preGuardSettings = readSettingsNoMigrate();

  // HOST_KEY/g moved here (Symbol.for is idempotent, same symbol as the guard
  // below): both memory wiring and todo-nudge need to know whether this
  // activation is happening in a child session (memory-plan §4.2).
  const HOST_KEY = Symbol.for("pi-subagent:host");
  const g = globalThis as Record<symbol, unknown>;
  // HOST_KEY already claimed at this point ⇒ this activation is happening in
  // a child session (the main session's /reload releases the claim on
  // session_shutdown before re-activating, so it can never be claimed here).
  // Known boundary (§4.3): if pi ever switches to "activate before shutdown",
  // the main session's reload instant would misread isChildSession as true;
  // the blast radius is limited to that instant's memory injection/write
  // gating and todo-nudge tracker gating, both with clear error copy.
  const isChildSession = Boolean(g[HOST_KEY]);
  const askUserRemoteRef: { current?: () => AskUserRemotePort | undefined } = {};

  if (preGuardSettings.webSearch.enabled) registerWebSearchTool(pi);
  // date 模块：首轮 + 跨日以隐藏消息注入当前日期（主/子会话都注入；pre-guard）。
  // enabled=false ⇒ wireDate 零注册。
  wireDate(pi, { enabled: preGuardSettings.date.enabled });
  // todo-nudge (L1 feature): the tracker only turns on for the main session
  // with todo.nudge.enabled; sendMessage matches the compact-hint/quota-hint
  // hidden-message shape (display:false, triggerTurn:false, never sendUserMessage).
  const todoWiring = preGuardSettings.todo.enabled
    ? wireTodo(pi, {
        isChildSession,
        nudge: preGuardSettings.todo.nudge,
        // todo-archive plan D1: completed-task auto-archive knobs (non-live, /reload to apply).
        archive: preGuardSettings.todo.archive,
        sendMessage: (message, options) => pi.sendMessage(message, options),
      })
    : undefined;

  // Sysprompt M2/M3: the hub is created before memory registers into it so
  // the memory section lands first in the fold order (registration order ==
  // fold order, §4.5/§4.6). It owns the single pre-guard before_agent_start /
  // context_with_system handler set for the whole session (main and child).
  const promptHub = createPromptSectionHub(pi, {
    mode: () => preGuardSettings.systemPrompt.mode,
    wakeReplay: preGuardSettings.systemPrompt.wakeReplay,
    adoptForeignForcedPrompt: preGuardSettings.systemPrompt.adoptForeignForcedPrompt,
  });

  // Merged armory-memory (memory-plan §4.1): pre-guard like web_search/todo so
  // child sessions keep the memory section and the memory tool (default
  // injectInChildSessions=true, aligned with the original plugin). M3: memory
  // registers a section into the hub instead of its own before_agent_start
  // hook — the hub folds memory -> agent types -> models in one handler.
  // todo #22 optimize-plan P0-b: the return value is captured so the
  // post-guard block below (main session only, structurally — a child
  // session returns before that code ever runs) can attach a real
  // `TidyPort` for `/mem tidy`/`/mem restore`.
  let memoryWiring: ReturnType<typeof wireMemory> | undefined;
  if (preGuardSettings.memory.enabled)
    memoryWiring = wireMemory(pi, { settings: preGuardSettings.memory, isChildSession, sections: promptHub });

  // bash-timeout-grace plan §3.4 (P5): the child (subagent) session half of
  // the auto-background feature — pre-guard, same rationale as memory/todo/
  // web_search above (activate() itself DOES re-run for every child session,
  // see src/bash/child.ts's own doc comment on `ensureManager` for exactly
  // which mechanism does and does not fire for a spawned child). Gated by
  // the SAME feature switch as the main session (`bashJobsEnabled`, §2.5/R6:
  // win32/threshold-0 off) AND `bashJobs.childSessions` (§5.1, U1 default on).
  if (isChildSession && bashJobsEnabled(preGuardSettings) && preGuardSettings.bashJobs.childSessions) {
    wireChildBashJobs(pi, { settings: preGuardSettings });
  }

  // child-context-switch plan §2/§7 (P3): the child (subagent) session half of switch_context
  // boundary drafts + cache-ttl keepalive — pre-guard, same rationale as bash P5 above (this
  // extension re-activates for every child session; the feature must not depend on
  // session_start, which child sessions never receive, plan §0 fact 3). Both sub-features gate
  // themselves on their own settings internally (compact.childSessions / cacheTtl.childKeepalive);
  // calling this unconditionally keeps the gating logic in one place (src/child/wire.ts).
  //
  // todo #27 (child-extension-missing diagnostic): mark the process-wide activation signal
  // (src/child/activation-signal.ts) UNCONDITIONALLY here too — the session driver reads it
  // to detect a child session that never activated this package at all (parent loaded it via
  // `-e`/`--no-extensions`, outside settings.json). Must not depend on any feature setting.
  if (isChildSession) {
    markChildExtensionActivated();
    wireChildSession(pi, preGuardSettings);
  }

  // Child subagent sessions bind extensions too (pi's bindExtensions), which
  // re-activates this extension inside every child. Without a guard, the
  // child instance registers its own Agent/SubagentWorkflow tools backed by
  // an empty stack — observed in the wild as "no active session yet" when a
  // subagent called SubagentWorkflow. The main-process instance is the host;
  // child instances stay inert (nested delegation uses X3's injected tool).
  //
  // The claim MUST be released on session_shutdown: pi's /reload clears the
  // extension cache and calls activate() again in the *same process*
  // (agent-session.ts reload() → emit session_shutdown(reason "reload") on the
  // old runner → resourceLoader.reload() → re-import → activate). A claim that
  // outlives its activation makes every post-reload instance inert — the whole
  // extension (Agent tool, /agent, hooks) silently disappears until pi is
  // restarted. Only the owning activation releases it, so a child session that
  // shuts down cannot hand the host role away.
  if (g[HOST_KEY]) return;
  const claim = { activatedAt: Date.now() };
  g[HOST_KEY] = claim;
  // Registered before the compat gate below so even the disabled-stub path
  // releases its claim (otherwise a bad-compat activation would wedge every
  // later reload into the inert branch).
  const settings = loadSettingsFromFile();
  const holder: { current?: Stack } = {};
  const xsEnabled = xsOn({
    fabric: settings.fabric,
    webHub: { enabled: settings.webHub.enabled, control: settings.webHub.control !== false },
  }); // frozen per activate: tools/caps/stack all share this gate
  const webHubRef: { current?: WebHubControl } = {};
  const xsFencePorts: { topicSwitch?: () => boolean; goal?: () => boolean } = {};
  const replyEnabled = xsEnabled && settings.fabric.crossSession.reply.enabled; // frozen per activate
  // Channel-plan §3.1/§6 (CHW): frozen per activate (non-live). Off ⇒ old-agent shape: no
  // `xs.channel.v1` cap, no `message_channel`, the legacy `list_sessions` instance, named channels suspended.
  const channelsOn = xsEnabled && settings.fabric.crossSession.channels.enabled;
  // Alias-plan §3.6/§6 (ALW): frozen per activate (non-live). Picks the alias tool descriptions, the agent cap
  // `xs.alias.v1` and the hub config key. Deliberately NOT the hub cap: a late/missing hub cap must never swap a
  // registered tool's description (provider cache prefix) — without it the runtime falls back to legacy addressing.
  const aliasOn = xsEnabled && settings.fabric.crossSession.alias.enabled;
  const xsLedger = getXsWakeLedger();
  const xsCapability = getXsHostCapability();
  const xsSessionOf = (ctx: { sessionManager?: { getSessionId(): string } }): string | undefined => {
    try {
      return ctx.sessionManager?.getSessionId();
    } catch {
      return undefined;
    }
  };
  let xsAttached = false;
  // Channel-plan §12.6 (IBW): TUI inbox badge + web status republish. The ctx is the latest session_start's.
  const xsInboxCtx: { current?: { ui?: { setStatus?: (key: string, text: string | undefined) => void } } } = {};
  let xsInboxShown: string | undefined;
  let xsInboxPublished = -1; // last count handed to the web publisher (-1 ⇒ force)
  const refreshXsInbox = () => {
    const n = holder.current?.xs?.unread?.() ?? 0;
    const text = n > 0 ? `inbox ${unreadDisplay(n)}` : undefined;
    if (text !== xsInboxShown) {
      xsInboxShown = text;
      try {
        xsInboxCtx.current?.ui?.setStatus?.(XS_INBOX_STATUS_KEY, text);
      } catch {
        /* stale ctx after a session switch: the next session_start re-renders */
      }
    }
    if (n === xsInboxPublished) return; // turn events fire often; only a changed count republishes
    xsInboxPublished = n;
    try {
      webHubRef.current?.xs?.notifyUnreadChanged();
    } catch {
      /* display hint only */
    }
  };
  let xsSessionId: string | undefined;
  let xsCollisions: string[] = [];
  let xsHubLimits: XsHubLimitsWire | undefined;
  // B1 stays installed even after an xs-off reload: old queued marked triggers still need
  // authorization. Never return the library TriggerResult as a pi hook result.
  pi.on("before_agent_start", (event, ctx) => {
    const trigger = readBeforeAgentStartTrigger(event);
    const marked =
      trigger.kind === "custom" &&
      trigger.customType === "subagent:xs" &&
      (trigger.details as { xsWake?: unknown } | undefined)?.xsWake === true;
    // Off means zero new context reads, except B1's mandatory orphan/old-authorization guard.
    if (!xsEnabled && xsLedger.size === 0 && !marked) return;
    const xs = xsAttached ? holder.current?.xs : undefined;
    if (xs?.controller) xs.beforeAgentStart(event);
    else if (xsAttached && holder.current?.rootWakeRecovery) {
      xs?.beforeAgentStart(event);
      holder.current.rootWakeRecovery.beforeAgentStart(event);
    } else {
      xs?.beforeAgentStart(event);
      // No owner yet (including the pre-stack window): never authorize an unsupervised
      // delayed action. Preserve the record as a tombstone until execution/teardown proof.
      const sessionId = xsSessionOf(ctx);
      for (const record of xsLedger.entries()) {
        if (sessionId !== undefined && record.sessionId === sessionId && record.state === "live")
          xsLedger.tombstone(record.token);
      }
      observeRootWakeTrigger(event, {
        sessionId: sessionId ?? "",
        abort: () => ctx.abort(),
        ledger: xsLedger,
        capability: xsCapability,
        ...(holder.current?.wake ? { level: holder.current.wake.level } : {}),
        audit: (event) => console.warn(`[pi-subagent] fabric xs ${event}`),
      });
    }
  });
  if (xsEnabled) {
    // Channel-plan §12.3 (IBW): unread inbox clearing rides the extension turn events (message_end is
    // unusable: pi runs extension handlers BEFORE persisting). Forwarders only; counting lives in unread.ts.
    pi.on("turn_start", () => holder.current?.xs?.unreadTurnStart());
    pi.on("turn_end", () => holder.current?.xs?.unreadTurnEnd());
    pi.on("agent_end", () => holder.current?.xs?.unreadAgentEnd()); // fallback when turn_end never fired
  }
  if (xsEnabled) {
    // Registered ahead of other async mutation hooks: the window closes BEFORE their awaits.
    pi.on("session_before_compact", () => {
      holder.current?.xs?.fence.onEvent({ type: "session_before_compact" });
    });
    pi.on("session_compact", () => {
      holder.current?.xs?.fence.onEvent({ type: "session_compact" });
      holder.current?.xs?.reply?.flush(); // §7.2: fence close evidence ⇒ retry owed notices
    });
    pi.on("session_compact_failed", () => {
      holder.current?.xs?.fence.onEvent({ type: "session_compact_failed" });
      holder.current?.xs?.reply?.flush(); // §7.2: fence close evidence ⇒ retry owed notices
    });
    pi.on("session_before_tree", () => {
      holder.current?.xs?.fence.onEvent({ type: "session_before_tree" });
    });
    pi.on("session_tree", () => {
      holder.current?.xs?.fence.onEvent({ type: "session_tree" });
      holder.current?.xs?.reply?.flush(); // §7.2: fence close evidence ⇒ retry owed notices
    });
    pi.on("session_before_switch", () => {
      holder.current?.xs?.fence.onEvent({ type: "session_before_switch" });
    });
    pi.on("session_before_fork", () => {
      holder.current?.xs?.fence.onEvent({ type: "session_before_fork" });
    });
  }
  pi.on("agent_settled", () => {
    holder.current?.xs?.settled();
    holder.current?.rootWakeRecovery?.settled();
  });
  // Same synchronous phase as session destruction, not the later (awaiting) fleet drain.
  // Fpi10: replacement first aborts the outgoing AgentSession; reload does NOT, so preserve
  // its authorizations/leases for explicit recovery. No time-based ledger cleanup.
  pi.on("session_shutdown", (event, ctx) => {
    xsAttached = false;
    holder.current?.xs?.fence.onEvent({ type: "session_shutdown" });
    holder.current?.xs?.dispose();
    holder.current?.rootWakeRecovery?.dispose();
    if (event.reason !== "reload") {
      const sessionId = xsSessionId ?? (xsEnabled || xsLedger.size > 0 ? xsSessionOf(ctx) : undefined);
      if (sessionId !== undefined) xsLedger.teardown(sessionId);
    }
  });
  // todo #22 optimize-plan P0-b (§7's spawn port): reads the CURRENT session
  // stack, same late-bound `holder.current` pattern as `forwardSpawn` below.
  // Only reached for the main session — structurally guaranteed by the
  // HOST_KEY early-return above, so this never runs for a child session.
  memoryWiring?.attachTidy({
    spawn: (req) => requireStack(holder).spawn.spawn(mapTidySpawnRequest(req)),
    waitOutcome: (runId, waitMs) => requireStack(holder).spawn.waitOutcome(runId, waitMs),
    abort: (runId, cause) => requireStack(holder).spawn.abort(runId, cause),
    snapshot: (runId) => holder.current?.query.get(runId),
  });
  const releaseBackgroundStatus = publishBackgroundStatus(() => {
    const stack = holder.current;
    // Background workflows count as running subagent work (between child runs they have no live run).
    // admitted-run-visibility fix (2026-10-08 incident): union with SpawnService's own
    // admission-time truth (runningIds()) — a just-admitted resume has no runner snapshot
    // yet, so the registry-only read below would otherwise miss it.
    const runningSubagents = stack
      ? countActiveRuns(stack.query.list(), stack.spawn.runningIds()) + stack.workflow.activity.list().length
      : 0;
    return {
      runningSubagents,
      runningBashJobs: bashJobsEnabled(settings) ? (stack?.bashJobs?.backgroundJobCount() ?? 0) : null,
    };
  });
  pi.on("session_shutdown", () => {
    releaseBackgroundStatus();
    if (g[HOST_KEY] === claim) delete g[HOST_KEY];
  });

  // child-context-switch plan.md §3.1 ("要点"): main-session, once-per-activate() alert on the
  // capability state machine's FIRST-ever transition into `disabled` (process-wide, so it can
  // fire from any child session's turn_end/context handler). Registered exactly once here
  // (never inside session_start, which can re-run across /reload) — `notifyCapabilityCtx.current`
  // always points at the latest live session_start ctx, so the toast still uses fresh UI state.
  // No ctx yet (disablement happened before the very first session_start, or a headless main
  // process) — falls back to `console.warn`, same convention as every other startup warning.
  const notifyCapabilityCtx: { current?: ExtensionContext } = {};
  getChildSwitchCapability().onDisabled((reason) => {
    const message =
      `\u5b50\u4f1a\u8bdd switch_context \u5df2\u5728\u672c\u8fdb\u7a0b\u505c\u7528\uff1a${reason}` +
      `\uff08pi \u8fd0\u884c\u65f6\u80fd\u529b\u68c0\u6d4b\u672a\u901a\u8fc7\uff09\uff0c\u5b50\u4f1a\u8bdd\u56de\u9000\u4e3a\u4ec5 pi \u81ea\u52a8\u538b\u7f29\u3002`;
    try {
      const ctx = notifyCapabilityCtx.current;
      if (ctx?.hasUI && typeof ctx.ui?.notify === "function") {
        ctx.ui.notify(message, "warning");
        return;
      }
    } catch {
      // fall through to console.warn below.
    }
    console.warn(`[pi-subagent] ${message}`);
  });

  // Merged ask_user (plugin-merge): HOST-SESSION ONLY. A child subagent session
  // runs in print mode (createAgentSession never binds a UI/mode), so the tool
  // could only ever return the headless error there — registering it merely put
  // a doomed tool in every subagent's tool list. Deliberately placed BEFORE the
  // compat gate: ask_user is independent of the subagent core, so a disabled
  // core (bad pi version) must not take it down.
  if (settings.askUser.enabled)
    wireAskUser(pi, {
      remote: () => askUserRemoteRef.current?.(),
      // ask-user-async §3.3 (P2): holder-routed port — /reload 后自然指向新
      // stack 的 hub；compat gate 失败 ⇒ holder 恒空 ⇒ 端口 undefined ⇒
      // ask_user 与今天逐字节一致。interrupt 设置逐字段回落默认（§6.1）。
      background: () => holder.current?.backgroundCompletions,
      interrupt: () => settings.askUser.backgroundInterrupt,
    });

  const cacheTtl = wireCacheTtl(pi, settings, {
    keepalive: () => holder.current?.keepalive,
    // O1/O3/O4 (provider-evidence, 2026-10-12): warmth 1h-horizon gating, usage observation
    // recording and the `/cache-ttl probe` writeback all share the process-wide store.
    evidence: getProviderEvidenceStore(),
  });
  // Built FRESH per activate(): depending on pi's version, /reload either
  // re-runs activate on the cached module or re-imports a FRESH module (jiti
  // moduleCache:false). A module-level mutable array would accumulate
  // duplicate entries across same-module activations — the stale ones closing
  // over an invalidated pi (observed in the wild: H2 fan-out hit a dead
  // worktree extension and crashed the run).
  const extensionPoints: SubagentExtensionPoints[] = [wireWorktree(pi, settings)];
  const types = createAgentTypeRegistry();
  // Eager warm-up: session_start's awaited reload() is authoritative, but a
  // prompt injected before it completes (or a session flow that skips it)
  // would otherwise see an empty registry — no prompt section AND every
  // spawn rejected as "unknown agent type". Fire-and-forget is safe:
  // reload() never throws (per-file errors are collected) and a concurrent
  // session_start reload just re-assigns the same result.
  void types.reload();
  const caps = detectPiCapabilities(pi);
  const compat = assertCompatible(caps);
  // Registered once per activate() (never inside buildSessionStack, which is
  // rebuilt per session_start and would accumulate duplicate handlers).
  // Handler lives in stack.ts so integration tests cover the real filter path.
  pi.on("message_start", createNotificationReceiptHook(holder));
  // ask-user-async plan §3.3 (P2): holder-routed forwarding into the current
  // stack's background-completion hub — message_start confirms minted tokens,
  // agent_end/agent_settled bound the orphan-detection window. Registered
  // once per activate() (post-guard: main session only — child sessions have
  // no ask_user and no stack). P1 subscribes to the port itself at :287 when
  // it lands; compat-gate failure ⇒ holder stays empty ⇒ all three no-op.
  const backgroundCompletionHook = createBackgroundCompletionEventHook(holder);
  pi.on("message_start", backgroundCompletionHook.onMessageStart);
  pi.on("agent_end", backgroundCompletionHook.onAgentEnd);
  pi.on("agent_settled", backgroundCompletionHook.onAgentSettled);
  // context-switch（docs/dev/context-switch/context-switch-plan.md）：工具与
  // session_before_compact 钩子之间的交接槽。每次 activate() 新建（/reload 后必须干净）。
  const handoffStore = new PendingHandoffStore();
  const loadHintState = createLoadHintState();
  pi.on(
    "turn_end",
    createCompactHintHook(holder, {
      sendMessage: (message, options) => pi.sendMessage(message, options),
      // deliverAs:"followUp": pi 1.2 counts the whole _prepareRun window (pre-compaction check +
      // all before_agent_start handlers) as busy, so the post-force onComplete resume can land
      // while a new run is starting — without deliverAs the text is silently dropped there
      // (extension_error only); idle runs ignore the option byte-for-byte (pi-1.2-compat §6.1).
      sendUserMessage: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
      handoffPending: () => handoffStore.hasFresh(),
    }),
  );
  // compact-hint 动态阈值（dynamic-threshold-plan.md D3 §5.4）：三个新事件 handler。全部经
  // holder 读当前会话的 runtime（/reload 后自然指向新 stack），mode=off / 惰性 runtime 下
  // 全部 no-op（§11.3 回滚保证 1：首行判空）。注册一次 per activate()（I7）。
  pi.on("tool_call", (event) => {
    if (!holder.current?.dynamic) return;
    // 纯辅助诊断：只记「叫过 switch_context」，恒不拦截、不改 event.input（T-D3-TOOLCALL-PASSTHRU）。
    const toolName = (event as { toolName?: unknown }).toolName;
    if (toolName === "switch_context") holder.current.dynamic.onToolCall(toolName);
  });
  pi.on("session_compact", (event, ctx) => {
    if (!holder.current?.dynamic) return;
    holder.current.dynamic.onSessionCompact(event, ctx);
  });
  pi.on("model_select", (event) => {
    if (!holder.current?.dynamic) return;
    holder.current.dynamic.noteModelSelected((event as { model?: unknown }).model);
  });
  // 额度感知派单（docs/dev/quota/quota-plan.md §4.2 / §5）：与 compact-hint 同一
  // turn_end 通道、同一 sendMessage 形状；状态在 stack 里（每次 session_start 重建，
  // 经 holder 读当前会话——/reload 存活）。alternatives 由 gate.ts 的
  // pickAlternatives 供给（Pack D 偏差 1：hook deps 的可选注入）。
  const isQuotaSubscription = parseSubscriptionProviders(settings.quota.subscriptionProviders);
  if (settings.load.enabled) {
    pi.on(
      "turn_end",
      createLoadHintHook({
        settings: settings.load,
        port: () => holder.current?.load?.port(),
        transition: () => holder.current?.loadTransition?.(),
        state: () => loadHintState,
        sendMessage: (message, options) => pi.sendMessage(message, options),
        context: () => {
          const ownRuns = holder.current?.query
            .list()
            .filter((s) => s.status === "running")
            .map((s) => s.diag.label ?? s.runId);
          return ownRuns === undefined ? {} : { ownRuns };
        },
      }),
    );
    pi.on("turn_end", () => holder.current?.refreshLoadStatus());
  }
  pi.on(
    "turn_end",
    createQuotaHintHook({
      state: () => holder.current?.quotaHint,
      verdicts: () => holder.current?.quota?.verdicts() ?? [],
      refresh: () => holder.current?.quota?.refreshIfStale(),
      sendMessage: (message, options) => pi.sendMessage(message, options),
      alternatives: (provider) =>
        pickAlternatives(provider, {
          verdictFor: (p) => holder.current?.quota?.verdictFor(p),
          // 只推荐 /models 里激活的模型（scope ∩ available，未配置 scope 时为 available）。
          available: () => holder.current?.models.recommendable() ?? [],
          isSubscription: isQuotaSubscription,
          // droid 池被拦时的 droid 内替代（quota-plan r2 §9；holder.current.quota
          // 即 QuotaService，K9）。适配器未构造 ⇒ 恒 [] ⇒ 输出字节不变。
          poolAlternatives: (b) => holder.current?.quota?.poolAlternatives(b) ?? [],
          // pi provider 被拦/告急时的补充候选（2026-10-15 拍板）：droid 未启用 ⇒
          // 恒 [] ⇒ 输出字节不变。
          droidAlternatives: () => holder.current?.quota?.droidAlternatives() ?? [],
        }),
    }),
  );

  // cache-ttl keepalive (plan.md §4): the armed-signal / drift-invalidation
  // event forwarders now live in `wireCacheTtl` (src/cache-ttl/cache-ttl.ts,
  // `wireKeepaliveEvents`) — assembly-only here, per AGENTS.md (M2 fix).

  if (!compat.ok) {
    pi.registerTool({
      name: "Agent",
      label: "Agent (unavailable)",
      description: `pi-subagent is disabled: ${compat.reason}`,
      parameters: { type: "object", properties: {}, required: [] } as never,
      async execute() {
        throw new Error(compat.reason);
      },
    });
    return;
  }

  // Reply-plan §9 (MW): the @session port reuses the SAME sender instance as the tools.
  let xsSender: XsSender | undefined;
  // Channel-plan §2.3 (CHW): live probe — local channels on ∧ live link ∧ the hub declared xs.channel.v1.
  const xsHubChannelCap = (): boolean => webHubRef.current?.xs?.hubPort().hubChannelCap?.() === true;
  // Alias-plan §3.6 (ALW): live probe — local alias on ∧ live link ∧ the hub declared xs.alias.v1 (AL3's state).
  const xsAliasUsable = (): boolean => aliasOn && webHubRef.current?.xs?.hubPort().aliasUsable?.() === true;
  // Channel-plan §2.3/§10 (CHW): the sender's channel view delegates to the CURRENT stack's membership
  // (rebuilt per session_start); no attached stack ⇒ empty sets / not joined (fail closed).
  const xsChannelView: XsChannelView = {
    pref: () => (xsAttached ? (holder.current?.xs?.membership.pref() ?? []) : []),
    effective: () => (xsAttached ? (holder.current?.xs?.membership.effective() ?? []) : []),
    link: (hubCap) => (xsAttached ? (holder.current?.xs?.membership.link(hubCap) ?? []) : []),
    linkJoined: (hubCap) => (xsAttached ? holder.current?.xs?.membership.linkJoined(hubCap) === true : false),
  };
  if (xsEnabled) {
    const sender = createXsSender({
      port: {
        list: (args) => webHubRef.current?.xs?.hubPort().list(args) ?? Promise.resolve({ kind: "off" }),
        resolve: (args) => webHubRef.current?.xs?.hubPort().resolve(args) ?? Promise.resolve({ kind: "off" }),
        send: (args) => webHubRef.current?.xs?.hubPort().send(args) ?? Promise.resolve({ kind: "off" }),
        ...(replyEnabled ? { replyCapable: () => webHubRef.current?.xs?.hubPort().replyCapable?.() === true } : {}),
        // Alias-plan §5.2 (ALW): alias mode ⇒ send pins the resolved full sessionId; off ⇒ key absent (legacy sender).
        ...(aliasOn ? { aliasUsable: xsAliasUsable } : {}),
        // Channel-plan §5.5/§4.1 (CHW): the channel ops ride the same late-bound bridge; absent bridge ⇒ off.
        ...(channelsOn
          ? {
              hubChannelCap: xsHubChannelCap,
              broadcast: (args) =>
                webHubRef.current?.xs?.hubPort().broadcast?.(args) ?? Promise.resolve({ kind: "off" as const }),
              channels: (args) =>
                webHubRef.current?.xs?.hubPort().channels?.(args) ?? Promise.resolve({ kind: "off" as const }),
            }
          : {}),
      },
      origin: {
        current: () => {
          const xs = xsAttached ? holder.current?.xs : undefined;
          return xs ? { sessionId: xs.sessionId(), epoch: xs.membership.epoch } : undefined;
        },
      },
      maxChars: settings.fabric.maxChars,
      ...(replyEnabled
        ? {
            reply: {
              ledger: getXsReplyLedger(),
              defaultTimeoutS: settings.fabric.crossSession.reply.defaultTimeoutS,
              maxTimeoutS: settings.fabric.crossSession.reply.maxTimeoutS,
              lateGraceS: settings.fabric.crossSession.reply.lateGraceS,
              maxPending: settings.fabric.crossSession.reply.maxPending,
              maxPendingPerTarget: settings.fabric.crossSession.reply.maxPendingPerTarget,
              receivable: (target: string) =>
                (xsAttached ? holder.current?.xs?.reply?.receivable(target) : undefined) ?? "not_joined",
              inbound: (requestId: string) => (xsAttached ? holder.current?.xs?.reply?.inbound(requestId) : undefined),
            },
          }
        : {}),
      ...(channelsOn ? { channels: xsChannelView } : {}),
      wakeOn: settings.fabric.wake.enabled,
      ...(settings.fabric.wake.enabled
        ? {
            level: {
              levelOfRoot: () => holder.current?.wake?.level.root ?? 0,
              hopAllowed: (level: number) => holder.current?.wake?.level.hopAllowed(level) ?? false,
            },
          }
        : {}),
    });
    xsSender = sender;
    // Alias-plan §6 (ALW): instances/descriptions frozen at activate by the LOCAL alias setting (see `aliasOn`).
    pi.registerTool(createListSessionsTool({ sender, channels: channelsOn, ...(aliasOn ? { alias: true } : {}) }));
    pi.registerTool(createMessageSessionTool({ sender, reply: replyEnabled, ...(aliasOn ? { alias: true } : {}) }));
    // Channel-plan §6.1 (CHW): main session only (this whole block is post-guard), xsOn ∧ channels.enabled.
    if (channelsOn) pi.registerTool(createMessageChannelTool({ sender }));
    const command = createFabricXsCommand({
      enabled: () => xsEnabled,
      sessionId: () => holder.current?.xs?.sessionId() ?? "",
      membership: () => holder.current?.xs?.membership,
      fence: () => holder.current?.xs?.fence,
      // Channel-plan §2.3 (CHW): not joined on THIS link ⇒ no resolve frame; the command falls back to
      // its offline full-id rule (an old hub would otherwise resolve for a non-member, C4).
      resolve: (query) =>
        channelsOn && !xsChannelView.linkJoined(xsHubChannelCap())
          ? Promise.resolve({ ok: false, kind: "offline" })
          : (webHubRef.current?.xs?.resolveBlock(query) ?? Promise.resolve({ ok: false, kind: "offline" })),
      replies: () => {
        const reply = holder.current?.xs?.reply;
        return reply ? { ledger: reply.ledger, maxPending: reply.maxPending } : undefined;
      },
      onPolicyChange: () => holder.current?.xs?.reply?.flush(),
      // Alias-plan §7 (ALW, AL4 port): always wired while xs is on — `localEnabled:false` still renders the
      // `alias n/a (alias.enabled=false)` status line; bridge/cache are AL3's (absent web-hub wiring ⇒ local refusal).
      alias: () => {
        const xs = aliasOn ? webHubRef.current?.xs : undefined;
        return {
          localEnabled: aliasOn,
          ...(xs ? { bridge: xs.aliasBridge(), cache: xs.aliasCache() } : {}),
          leaseDays: Math.round((settings.fabric.crossSession.alias.offlineLeaseH / 24) * 10) / 10,
          coolMin: settings.fabric.crossSession.alias.coolMin,
          suggestions: () =>
            aliasSuggestions({
              cwd: notifyCapabilityCtx.current?.cwd,
              sessionName: (() => {
                try {
                  return notifyCapabilityCtx.current?.sessionManager.getSessionName();
                } catch {
                  return undefined;
                }
              })(),
            }),
        };
      },
      // Channel-plan §6.3 (CHW): the hub listing (also the completion cache's refresh source — the
      // command itself refreshes after status/channels/join/leave; the completer never does I/O).
      ...(channelsOn
        ? {
            channels: async () => {
              const out = await sender.channels();
              return out.status === "ok"
                ? { ok: true as const, channels: out.channels ?? [] }
                : { ok: false as const, reason: out.reason ?? out.status };
            },
            broadcast: () => ({
              outPerHour: settings.fabric.crossSession.channels.broadcast.outPerHour,
              wakeOutPerHour: settings.fabric.crossSession.channels.broadcast.wakeOutPerHour,
              wakeMaxRecipients: settings.fabric.crossSession.channels.broadcast.wakeMaxRecipients,
            }),
          }
        : {}),
      hubChannelCap: () => {
        // `undefined` ⇔ no live hub link (n/a); otherwise whether THIS hub declared xs.channel.v1.
        const conn = webHubRef.current?.xs !== undefined ? currentConnection() : undefined;
        return conn !== undefined && conn.status().state === "live"
          ? conn.caps.includes(XS_CHANNEL_HUB_CAP)
          : undefined;
      },
      directoryChannels: () => {
        const directory = xsAttached ? holder.current?.xs?.directory : undefined;
        return directory ? directory.rows().flatMap((row) => row.channels ?? []) : [];
      },
      autoJoinInvalid: () =>
        settings.fabric.crossSession.autoJoin && settings.fabric.crossSession.channels.autoJoinInvalid,
      statusView: () => {
        const xs = holder.current?.xs;
        const quota = xs?.receiver.wakeQuota();
        return {
          capability: xsCapability.state,
          lines: [
            ...(quota
              ? [`in ${quota.recvUsed}/${quota.recvCap} h · wakes ${quota.wakesUsed}/${quota.wakesCap} h`]
              : []),
            ...(xs
              ? [
                  `inbox unread ${xs.unread?.() ?? 0}`,
                  `controller ${xs.controller?.state ?? "off"} · inbox ${xs.inbox.occupied}/${xs.inbox.cap}`,
                  `counts ${JSON.stringify(xs.receiver.countersSnapshot())}`,
                  `audit ${JSON.stringify(xs.audit)}`,
                ]
              : []),
            ...(xsHubLimits
              ? [
                  `hub sends ${xsHubLimits.hubSendsPerMin}/min · local ${settings.fabric.crossSession.limits.hubSendsPerMin}/min${xsHubLimits.hubSendsPerMin !== settings.fabric.crossSession.limits.hubSendsPerMin ? " · differs" : ""}`,
                ]
              : ["hub limits unavailable"]),
            ...(xsCollisions.length ? [`tool collisions: ${xsCollisions.join(", ")}`] : []),
          ],
        };
      },
    });
    pi.registerCommand("fabric", {
      ...command,
      handler: async (args, ctx) => {
        if (args.trim() === "" || args.trim() === "status") xsHubLimits = await webHubRef.current?.xs?.hubInfo();
        await command.handler(args, ctx);
      },
    });
  }

  if (caps.canRenderEntries) {
    // Renderer lives in adapters/fabric-entry-renderer.ts and renders ONLY
    // delivered records: the fabric outbox store appends one entry per state
    // transition, and rendering each one duplicated every fabric message in
    // the chat (pending/claimed appends + delivered append).
    // Show the sender alongside kind: prefer the mention label (@name),
    // falling back to the raw runId when no label is registered.
    pi.registerEntryRenderer(
      FABRIC_ENTRY_CUSTOM_TYPE,
      createFabricEntryRenderer((runId) => {
        const mention = holder.current?.mention;
        if (!mention) return undefined;
        for (const label of mention.labels()) {
          if (mention.resolve(label)?.runId === runId) return label;
        }
        return undefined;
      }),
    );
  } else {
    console.warn("[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context");
  }
  // Markdown body rendering for the Agent / get_subagent_result cards.
  // getMarkdownTheme() reads pi's global theme, which throws before the
  // interactive theme subsystem is initialized (headless/print mode, tests)
  // — the tools fall back to their legacy plain-text cards in that case.
  const resolveMarkdownTheme = () => {
    try {
      return getMarkdownTheme();
    } catch {
      return undefined;
    }
  };
  pi.registerTool(
    createAgentTool({
      // Top-level Agent always runs in the background (docs/dev/agent-background-only):
      // only spawn() is reached; the outcome arrives through the notification outbox.
      spawn: forwardSpawn(holder),
      markdownTheme: resolveMarkdownTheme,
      // consult (plan §6 D-16): dispatch-time `experts` resolution for the
      // top-level Agent tool — the main session itself never gets the
      // consult tool (§4.2/§5.2), but it CAN authorize a whitelist for a
      // dispatched child (agent-tool.ts throws on failure to resolve).
      resolveExperts: (refs) => requireStack(holder).consult.resolveExperts(refs),
      // L1 (agent-tool pool-full plan §2): read fresh on every call so a
      // live `/agent settings` edit (or /reload) takes effect immediately,
      // same convention as worktreeAvailable/resolveExperts above.
      queueWhenFull: () => settings.agent.queueWhenFull,
      loadGate: () => holder.current?.load?.port().verdict().gating === true,
    }),
  );
  pi.registerTool(
    createResultTool({
      query: forwardQuery(holder),
      resolveRun: forwardResolveRun(holder),
      notifier: forwardNotifier(holder),
      resultMaxChars: () => settings.resultMaxChars,
      markdownTheme: resolveMarkdownTheme,
      workflows: forwardWorkflowQuery(holder),
      wake: { inboxCount: (runId) => holder.current?.wake?.inboxCount(runId) ?? 0 },
    }),
  );
  pi.registerTool(
    createListSubagentsTool({
      query: forwardQuery(holder),
      spawn: { slots: () => requireStack(holder).spawn.slots() },
      workflow: { activity: { list: () => requireStack(holder).workflow.activity.list() } },
      now: () => systemClock.now(),
    }),
  );
  // steer reply (steer-tool reply param): same fabric signal as the @mention
  // wiring below (`holder.current?.fabric != null`) — read live at call time
  // so a /reload or settings change takes effect without re-registration.
  pi.registerTool(
    createSteerTool({
      query: forwardQuery(holder),
      resolveRun: forwardResolveRun(holder),
      fabricEnabled: () => holder.current?.fabric != null,
    }),
  );
  // set_model host form (plan §4.11): self-switch goes through the ExtensionAPI
  // (only available when the pi build exposes it — otherwise `host` stays
  // absent and self-switching degrades to a clear error while switching a
  // running subagent keeps working). All stack reads go through the holder at
  // call time so the tool survives session_start rebuilds.
  pi.registerTool(
    createSetModelTool({
      ...(caps.canSetModel
        ? {
            host: {
              setModel: (model) => pi.setModel(model as never),
              getThinkingLevel: () => pi.getThinkingLevel(),
              setThinkingLevel: (level) => pi.setThinkingLevel(level as never),
              findModel: (p, id) => holder.current?.models.find(p, id),
            },
          }
        : {}),
      runs: { setModel: (runId, model, opts) => requireStack(holder).query.setModel(runId, model, opts) },
      resolveHint: (hint) => holder.current?.models.resolveHint(hint),
      available: () => holder.current?.models.available() ?? [],
      // external-agent plan §5.4/§5.5（P5）：仅 externalAgents.droid.enabled 时注入（settings
      // 在 activate() 快照；enabled ⇒ 每个 session stack 都带端口）。谓词经 holder 晚绑定，
      // /reload 后新栈缺席即自动失效；缺席 ⇒ droid/x 走原未知模型路径（字节一致，评审 #7）。
      ...(settings.externalAgents.droid.enabled
        ? { externalOwns: (p: string) => holder.current?.external?.owns(p) === true }
        : {}),
      resolveRun: forwardResolveRun(holder),
      labelOf: (runId) => holder.current?.query.get(runId)?.diag.label,
    }),
  );
  pi.registerTool(
    createAbortTool({
      query: forwardQuery(holder),
      resolveRun: forwardResolveRun(holder),
      workflows: forwardWorkflowQuery(holder),
    }),
  );
  // timeout-notify：extend.enabled=false 时工具不注册（spawn 侧同步钳 maxExtensions=0，D-16）。
  if (settings.extend.enabled) {
    pi.registerTool(
      createExtendTimeoutTool({
        query: forwardQuery(holder),
        resolveRun: forwardResolveRun(holder),
        workflows: forwardWorkflowQuery(holder),
        now: () => systemClock.now(),
      }),
    );
  }
  // HOST_KEY guard above means this registration is visible only in the main session.
  if (settings.compact.enabled) {
    if (settings.compact.switchTool) {
      pi.registerTool(
        createSwitchContextTool({
          store: handoffStore,
          // deliverAs:"followUp": on pi 1.2 the onComplete resume can race a run that is still
          // inside its startup window (busy) — queue instead of dropping (pi-1.2-compat §6.1);
          // idle behavior is byte-identical on every supported pi version.
          sendUserMessage: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
          // todo-nudge switch-before hint (L1 feature): only wired when the
          // tracker is actually active — wireTodo returns no port at all
          // when todo.nudge is disabled or todo itself is off, so a disabled
          // feature stays byte-identical to "not injected".
          ...(todoWiring?.getTrackerSnapshot ? { todoTracker: todoWiring.getTrackerSnapshot } : {}),
        }),
      );
      // 模型自写的交接文本在这里变成 pi 压缩条目的 summary（零摘要 LLM 调用）。
      pi.on(
        "session_before_compact",
        createSwitchContextCompactHook({
          store: handoffStore,
          sessionFacts: createSessionFactsProvider(holder, settings),
          // R2-1：唯一因果信号——交接文本真的被采用时开火（带 seq），供动态遥测建 handoffMarker。
          onApplied: (info) => holder.current?.dynamic?.noteHandoffApplied(info),
          debug: process.env.PI_SUBAGENT_DEBUG_COMPACT_HINT === "1",
        }),
      );
      // 压缩失败/被取消：交接文本作废，绝不能留给下一次（可能是几十轮后）的压缩。
      // 动态遥测的两个 marker 同步清（§5.4 清除③；归因不能落在失败的一次上）。
      pi.on("session_compact_failed", () => {
        handoffStore.clear();
        holder.current?.dynamic?.clearMarkers("compact-failed");
      });
      pi.on("session_shutdown", () => handoffStore.clear());
    }
    // 彻底替换为默认：switchTool 开启时不再暴露 compact_context，
    // 除非显式 compact.keepCompactTool=true（回退开关）。
    if (!settings.compact.switchTool || settings.compact.keepCompactTool) {
      // Same deliverAs rationale as the switch_context closure above (pi-1.2-compat §6.1).
      pi.registerTool(
        createCompactTool({ sendUserMessage: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }) }),
      );
    }
    pi.registerTool(
      createSetCompactThresholdTool({
        getState: () => holder.current?.compactHint,
        compactToolEnabled: () => settings.compact.enabled,
        toolName: settings.compact.switchTool ? "switch_context" : "compact_context",
        dynamic: { view: () => holder.current?.dynamic?.statusView() },
      }),
    );
  }
  // bash auto-background (§2.6/R6): the same-name `bash` override and its
  // `bash_job` management tool exist only when the feature is on — off means
  // pi's built-in bash stays in place with zero behaviour change.
  if (bashJobsEnabled(settings)) {
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
        // deadlinePolicy — src/stack.ts's `buildBashJobManager` — is enabled).
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
  // Inject the registered agent types and available models through the hub.
  // The hub owns the stable/live/legacy mode, persistence, updates, and wake
  // replay capture. Its registration order is the existing types -> models
  // order; the memory section (registered pre-guard by wireMemory, M3) has
  // already contributed the first section.
  promptHub.register("pi_subagent_types", agentTypesSection({ types }));
  promptHub.register(
    "pi_subagent_models",
    availableModelsSection({
      stackAvailable: () => holder.current?.models.available(),
      // external-agent plan §5.3/§5.5（P5）：端口存在时投影 droid 子块——advertiseMax 截断
      // 与 total（… +N more）都在这里（§15 跟踪项 4）；tokenMultiplier 已折进 note。非空
      // models 同时是白名单（2026-10-16 拍板）⇒ 全量名单随子块透传，头部说明改写。
      externalModels: () => {
        const port = holder.current?.external;
        if (port === undefined) return undefined;
        const all = port.advertised();
        const max = settings.externalAgents.droid.advertiseMax;
        const allowlist = settings.externalAgents.droid.models;
        return [
          {
            provider: "droid",
            models: all.slice(0, max),
            total: all.length,
            ...(allowlist.length > 0 ? { allowlist } : {}),
          },
        ];
      },
    }),
  );
  // CC3/M3.6: the workflow engine stays entirely inert (stub tool, clear
  // error message) unless settings.workflow.enabled — decided once here
  // rather than per-session, since `settings` itself is loaded once.
  pi.registerTool(
    settings.workflow.enabled ? createWorkflowTool(forwardWorkflow(holder)) : createDisabledWorkflowToolStub(),
  );
  // /goal 目标驱动持续运行（goal-plan v4 条件 5）：循环钩子挂 agent_settled
  // （唯一「无 retry/压缩/续跑待决」信号）；abort 检测所需的末条 stopReason
  // 由 agent_end 记录（agent_settled 无消息载荷，见 goal/hook.ts 与
  // adapters/pi-compat.ts 的未文档化行为假设登记）。两个注册各一次（I7）。
  const goalHook = createGoalLoopHook(holder, {
    exec: async (cmd, opts) => {
      const result = await pi.exec("bash", ["-c", cmd], { timeout: opts.timeoutMs, cwd: opts.cwd });
      return { code: result.code, killed: result.killed, stdout: result.stdout, stderr: result.stderr };
    },
    sendUserMessage: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
    persist: (record) => persistGoalRecord(pi, record),
  });
  xsFencePorts.goal = () => goalHook.goalBusy();
  pi.on("agent_end", goalHook.onAgentEnd);
  pi.on("agent_settled", goalHook.onAgentSettled);
  pi.registerCommand(
    "goal",
    createGoalCommand({ goal: () => holder.current?.goal, persist: (record) => persistGoalRecord(pi, record) }),
  );
  // Deferred /reload (src/reload/): the controller itself is wired at the
  // bottom of activate() — its session_start handler must run AFTER
  // session-nav's so the editor wrapper layers on top of SessionNavEditor —
  // but /agent needs it now, so the command gets a facade over this ref.
  const reloadRef: { current?: DeferredReloadController } = {};
  // Background workflows count too (a workflow between child runs has no live run but is still busy).
  // admitted-run-visibility fix (2026-10-08 incident): union with SpawnService's own admission-time
  // truth (runningIds()) — a just-admitted run has no registry snapshot yet (resume's session-open
  // can take a while before its first one lands), so the registry-only filter below would otherwise
  // under-count and let a reload race ahead of a run nobody can see yet.
  const activeSubagentRunCount: DeferredReloadDeps["activeRunCount"] = () => {
    const stack = holder.current;
    if (!stack) return 0;
    return countActiveRuns(stack.query.list(), stack.spawn.runningIds()) + stack.workflow.activity.list().length;
  };
  pi.registerCommand(
    "agent",
    createStatusCommand({
      query: forwardQuery(holder),
      resolveRun: forwardResolveRun(holder),
      orphans: forwardOrphans(holder),
      notifier: forwardNotifier(holder),
      workflow: {
        activity: { list: () => holder.current?.workflow.activity.list() ?? [] },
        now: () => systemClock.now(),
      },
      bashJobs: { list: () => holder.current?.bashJobs?.list() ?? [] },
      mention: {
        entries: () => mentionAutocompleteEntries(holder),
      },
      // admitted-run-visibility fix (2026-10-08 incident): same admission-time union as
      // activeSubagentRunCount/publishBackgroundStatus above — `/agent reload fire`'s own
      // re-count (countBusy in status.ts) must see it too.
      admittedRunIds: () => holder.current?.spawn.runningIds() ?? [],
      // child-context-switch plan.md §3.1 (P3): read-only capability-state port for the
      // "child switch: verified | ready | disabled(<reason>)" line — process-wide, works even
      // before the first session_start (no stack needed).
      childSwitch: () => getChildSwitchCapability().get(),
      // workflow-worktree plan §3 (P4 wt-orphans): always rescans the current stack's live
      // registry; before the first session_start (no stack yet) degrades to an empty scan
      // at the same default root the worktree extension itself uses.
      worktreeOrphans: () =>
        holder.current?.worktreeOrphans() ?? { root: worktreeRoot(), count: 0, capped: false, entries: [] },
      wake: () => holder.current?.wake?.status(),
      xs: () => {
        const stack = holder.current?.xs;
        return stack
          ? { stack, capability: xsCapability.state, outCap: settings.fabric.crossSession.limits.sendsOutPerHour }
          : undefined;
      },
      load: () => {
        const port = holder.current?.load?.port();
        if (!port) return undefined;
        const verdict = port.verdict();
        return verdict.level === "unknown" ? undefined : { level: verdict.level, gating: verdict.gating };
      },
      // quota droid 凭据缺失披露（2026-10-19 用户拍板）：只读当前 stack 的 QuotaService；
      // quota 关闭 / stack 未建 ⇒ undefined ⇒ /agent status 不渲染该行。
      quota: () => {
        const q = holder.current?.quota;
        if (q === undefined) return undefined;
        return { droidKeyMissing: q.droidCredentialMissing() };
      },
      external: () => {
        const port = holder.current?.external;
        return port === undefined ? undefined : { droidUnavailableReason: port.unavailableReason("droid") };
      },
      // compact-hint 动态阈值（§10.3，P1-11）：经 holder 读当前会话（/reload 后自然指向新 stack）。
      // facts() 只读快照 compactHint 的 force/reserve 配置；窗口由命令时点的 ctx.getContextUsage 给。
      dynamic: {
        view: () => holder.current?.dynamic?.statusView(),
        facts: () => {
          const state = holder.current?.compactHint;
          if (!state) return undefined;
          return {
            thresholdPercent: state.thresholdPercent,
            thresholdTokens: state.thresholdTokens,
            forceAtPercent: state.forceAtPercent,
            forceAtTokens: state.forceAtTokens,
            forceScaling: state.forceScaling,
            reserveTokens: state.reserveTokens,
          };
        },
      },
      settings: {
        // settings.budget is passed by reference into every session stack
        // (stack.ts) and read at spawn time (spawn-service mergeBudget), so
        // in-place budget.* mutation takes effect for new runs without a
        // reload. Other keys are captured at activate/session build — the
        // command tells the user to /reload for those.
        current: settings,
        persist: (key, value) => persistSettingOverride(key, value),
        path: defaultSettingsPath(),
        // L1 (agent-tool pool-full plan §4): concurrencyLimit is the one
        // exception — the SlotPool captures it once in its constructor
        // (stack.ts), so mutating settings.concurrencyLimit in place does not
        // by itself reach an already-built pool. Forward the write to the
        // CURRENT session's real SpawnService (never the forwardSpawn shim,
        // which just re-reads holder itself) so /agent settings takes effect
        // immediately instead of requiring /reload. Absent stack (no active
        // session yet) is a silent no-op — there is nothing live to update.
        onWrite: (key, value) => {
          if (key === "concurrencyLimit" && typeof value === "number") holder.current?.spawn.setConcurrencyLimit(value);
        },
      },
      reload: {
        arm: (n) => reloadRef.current?.arm(n),
        disarm: () => reloadRef.current?.disarm(),
        get pending() {
          return reloadRef.current?.pending ?? false;
        },
      },
    }),
  );

  // /task：用户直接派一个后台 general-purpose subagent（src/commands/task.ts）。
  // 仅主会话（HOST_KEY 守卫之后）；spawn 经 holder 转发到当前会话栈，与
  // Agent 工具后台路径同一条 SpawnService → notification outbox 链路。
  pi.registerCommand(
    "task",
    createTaskCommand({
      spawn: (req) => requireStack(holder).spawn.spawn(req),
      sendMessage: (message, options) => pi.sendMessage(message, options),
    }),
  );
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer(TASK_STARTED_CUSTOM_TYPE, renderTaskStartedMessage);
    // RX7 D-display: clean TUI form for received cross-session messages (wake/deliver/reply).
    pi.registerMessageRenderer("subagent:xs", renderXsMessage);
  }

  // X6: @handle mentions. Registered once; resolves through the current
  // session's stack like the tools above. Conservative by contract: unknown
  // labels and @file/paths fall through to pi untouched.
  // Reply-plan §9.1 static facts shared by routing and completion (all LIVE reads).
  const sessionParseDeps = () => ({
    isLabel: (name: string) => holder.current?.mention.resolve(name) !== undefined,
    cwd: () => notifyCapabilityCtx.current?.cwd ?? process.cwd(),
    lookupExact: (name: string) => {
      const directory = xsAttached ? holder.current?.xs?.directory : undefined;
      const row = directory?.lookupExact(name);
      // A miss on a shape-valid bare name warms the (throttled, single-flight) cache so the NEXT
      // attempt can match; this attempt still passes through to pi (RR8).
      if (row === undefined) void directory?.refresh("lookup");
      return row;
    },
    // Alias-plan §5.4 (ALW, AL5b): LIVE alias mode + the directory's unique alias lookup. Absent while alias is off
    // ⇒ the parse path is byte-identical to the pre-alias one.
    ...(aliasOn
      ? {
          aliasMode: xsAliasUsable,
          lookupAlias: (alias: string) => {
            const directory = xsAttached ? holder.current?.xs?.directory : undefined;
            const row = directory?.lookupAlias(alias);
            // §5.4 step 6: a miss on an alias-shaped token (only reached after normalizeAlias ∧ label/file checks)
            // warms the throttled single-flight cache; this attempt still falls through.
            if (row === undefined) void directory?.refresh("mention");
            return row;
          },
        }
      : {}),
  });
  // Reply-plan §9.4/§9.6: human-origin @session notices are display-only (never triggerTurn).
  const sessionNoticeMessage = (notice: SessionMentionNotice) =>
    notice.kind === "error"
      ? {
          customType: "subagent:mention-error",
          content: notice.message,
          display: true,
          details: { source: SESSION_MENTION_ERROR_SOURCE },
        }
      : {
          customType: SESSION_MENTION_SENT_CUSTOM_TYPE,
          content: notice.message,
          display: true,
          details: { source: SESSION_MENTION_ERROR_SOURCE },
        };
  // Reply-plan §9.3: present iff xs is on. `joined` is a LIVE read (join/leave/connect are
  // call-time facts, §9.3/§9.7) — xs off / not joined / left ⇒ parse() undefined ⇒ `@` passes through.
  const mentionSessions: MentionSessionPort | undefined = xsSender
    ? createMentionSessionPort({
        ...sessionParseDeps(),
        // Channel-plan §2.3 (CHW): the LINK set — a named-channel-only session on an old hub passes `@` through.
        joined: () =>
          xsAttached &&
          holder.current?.xs?.membership.linkJoined(channelsOn && xsHubChannelCap()) === true &&
          webHubRef.current?.xs !== undefined,
        send: async (target, message, options) => {
          const out = await xsSender!.message({
            to: target,
            text: message,
            wake: true,
            ...(options?.expectReply === false ? {} : { expectReply: {} }),
            origin: "human",
            levelOverride: 0,
          });
          return mapMentionSendOutcome(out, settings.fabric.crossSession.reply.maxPending);
        },
      })
    : undefined;
  const mentionRouteDeps = createMentionRouteDeps({
    ...(mentionSessions ? { sessions: mentionSessions } : {}),
    registry: {
      register: () => false, // registrations flow from spawn labels inside the stack
      resolve: (label) => holder.current?.mention.resolve(label),
      labels: () => holder.current?.mention.labels() ?? [],
      reassign: () => undefined, // label re-pointing is driven by the stack's onLabel wiring
    },
    query: forwardQuery(holder),
    spawn: forwardSpawn(holder),
    // message_agent reply hint only when fabric is on (subagents own the tool then)
    fabricEnabled: () => holder.current?.fabric != null,
    // X6b: surface the user's raw @ message in the fleet widget under the target run
    noteMention: (runId, message, pendingSince) => holder.current?.mentionNotes.set(runId, message, pendingSince),
  });
  const wakeAttributeRef: { current?: (text: string) => "web_prompt" | undefined } = {};
  // fabric-cross-session plan §3.3 L7 (W1): proven human input resets the root causal level. Registered once per
  // activate() (post-guard: main session only) BEFORE the mention / topic-switch input handlers so a `handled` answer
  // from them can't hide a human input; the handler's first check is the live `holder.current?.wake` (wake off ⇒ inert).
  pi.on(
    "input",
    createWakeInputHook({
      level: () => holder.current?.wake?.level,
      attributeInput: () => wakeAttributeRef.current,
    }),
  );
  pi.on("input", (event) => {
    (holder.current?.xs?.controller ?? holder.current?.rootWakeRecovery)?.input(event, wakeAttributeRef.current);
    return { action: "continue" };
  });
  installMentionInput(pi, mentionRouteDeps);

  pi.on("session_start", async (_event, ctx) => {
    xsAttached = false;
    const nextXsSessionId = xsEnabled || xsLedger.size > 0 ? xsSessionOf(ctx) : undefined;
    notifyCapabilityCtx.current = ctx;
    if (compat.warning) console.warn(`[pi-subagent] ${compat.warning}`);
    // Defensive: if pi ever fires session_start without a paired shutdown,
    // stop the previous stack's timer/RPC surfaces so they cannot double-fire.
    if (holder.current) {
      // ask-user-async §3.3 (P2): stop the old hub's broadcast FIRST so a
      // completion flushed by the teardown below can never reach the new
      // session's ask_user (idempotent; shutdown is the other path).
      holder.current.xs?.dispose();
      holder.current.rootWakeRecovery?.dispose();
      // Defensive replacement without shutdown: a NEW identity proves the old session ended.
      // Same-session reload is deliberately not proof.
      if (xsSessionId && nextXsSessionId !== undefined && xsSessionId !== nextXsSessionId)
        xsLedger.teardown(xsSessionId);
      holder.current.backgroundCompletions.dispose();
      holder.current.fleetWidget?.dispose();
      holder.current.keepalive?.dispose();
      holder.current.quota?.dispose();
      holder.current.external?.dispose(); // external-agent plan §5.5（P5）：停目录探测（与 /reload 重建双保险）
      holder.current.dynamic?.dispose(ctx); // P1-4：防御性清理（与 shutdown 双保险，幂等）
      holder.current.load?.dispose();
      holder.current.scheduler.stop();
      holder.current.rpc.close();
      holder.current.fabric?.dispose();
      holder.current.workflow.runs.abandon(); // stop orphaned background workflows; their notices are dropped
      holder.current.consult.close(); // consult cache-thread plan §7 (②): retained thread heads + ledger (idempotent)
    }
    await types.reload();
    const stack = buildSessionStack(
      pi,
      ctx,
      settings,
      types,
      [mergeExtensionPoints(extensionPoints)],
      _event.reason,
      loadHintState,
      // external-agent plan §5.5（P5）：memory 的外部导出（P4a renderForExternal）经
      // holder 晚绑定——wireMemory 在 activate() 早期已返回，这里只传 getter；是否
      // 真正注入由 buildSessionStack 按 externalAgents.droid.{enabled,injectMemory} 判定。
      memoryWiring !== undefined ? { memoryBlock: (cwd: string) => memoryWiring?.renderForExternal(cwd) } : undefined,
      xsEnabled
        ? {
            ports: {
              webExec: () => webHubRef.current?.webExecBusy?.() === true,
              topicSwitch: () => xsFencePorts.topicSwitch?.(),
              goal: () => xsFencePorts.goal?.(),
            },
            memberChanged: () => webHubRef.current?.xs?.publishMember(),
            unreadChanged: refreshXsInbox,
            ...(channelsOn ? { hubChannelCap: xsHubChannelCap } : {}),
            ...(aliasOn ? { aliasUsable: xsAliasUsable } : {}),
            listRows: async (origin) => {
              const reply = await webHubRef.current?.xs?.hubPort().list({ origin });
              return reply?.kind === "res" && reply.res.ok ? (reply.res.rows ?? []) : undefined;
            },
          }
        : undefined,
    );
    holder.current = stack;
    xsSessionId = nextXsSessionId;
    if (xsEnabled) {
      xsInboxCtx.current = ctx;
      xsInboxPublished = -1;
      xsInboxShown = "\u0000"; // new session/reload: force one re-render of the (possibly retained) count
      refreshXsInbox();
    }
    xsAttached = xsSessionId !== undefined && (stack.xs !== undefined || stack.rootWakeRecovery !== undefined);
    if (xsEnabled) {
      // The toolkit's own two declarations are not collisions. Keep foreign declarations and
      // duplicates (when the host exposes them); C-X7 tests host-specific name arbitration.
      try {
        // Channel-plan §6 (CHW): compare against the instances THIS activation registered.
        const own = new Map<string, unknown>([
          ["list_sessions", listSessionsParamsFor(channelsOn)],
          ["message_session", messageSessionParamsFor(replyEnabled)],
          ...(channelsOn ? ([["message_channel", MessageChannelParams]] as const) : []),
        ]);
        xsCollisions = detectXsToolCollisions(
          pi
            .getAllTools()
            .filter(
              (tool) => !own.has(tool.name) || JSON.stringify(tool.parameters) !== JSON.stringify(own.get(tool.name)),
            )
            .map((tool) => tool.name),
          { channels: channelsOn },
        );
        if (xsCollisions.length) console.warn(`[pi-subagent] fabric xs tool collisions: ${xsCollisions.join(", ")}`);
      } catch {
        /* older host / unbound runtime: diagnostic only */
      }
    }
    if (ctx.hasUI && typeof ctx.ui.addAutocompleteProvider === "function") {
      ctx.ui.addAutocompleteProvider((current) =>
        createMentionAutocompleteProvider(current, {
          entries: () => mentionAutocompleteEntries(holder),
          ...(mentionSessions
            ? {
                sessions: () => {
                  const directory = xsAttached ? holder.current?.xs?.directory : undefined;
                  if (!directory) return [];
                  void directory.refresh("complete"); // never awaited (§9.5)
                  return directory.rows().map((row) => ({
                    ref: row.ref,
                    ...(row.name !== undefined ? { name: row.name } : {}),
                    cwdLabel: row.cwdLabel,
                    receive: row.receive,
                    busy: row.busy,
                    ...(row.channels !== undefined && row.channels.length > 0 ? { channels: row.channels } : {}),
                    ...(aliasOn && row.alias !== undefined ? { alias: row.alias } : {}),
                  }));
                },
                sessionBareName: (name: string) => sessionCompletionBare(sessionParseDeps(), name),
                ...(aliasOn
                  ? { sessionBareAlias: (alias: string) => sessionCompletionAlias(sessionParseDeps(), alias) }
                  : {}),
              }
            : {}),
        }),
      );
    }
    stack.notifier.reconcile();
    // Background workflows (plan §3.2): notices the previous stack persisted while shutting down.
    stack.workflow.redeliverPendingNotices();
    stack.fabric?.pump(); // RC5: synchronous, never blocks startup
    await stack.scheduler.start(); // X5
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const stack = holder.current;
    if (!stack) return;
    // ask-user-async §3.3 (P2): FIRST — the hub stops broadcasting before the
    // drain/seal below settles anything; completions surfacing during shutdown
    // must not interrupt whatever session comes next. Idempotent (the next
    // buildSessionStack's top-of-build dispose is the same call).
    stack.backgroundCompletions.dispose();
    // X7b: kill the fleet widget FIRST and unconditionally. pi's /reload
    // re-imports this extension as a fresh module (jiti moduleCache:false), so
    // the module-level previousFleetWidget handoff in buildSessionStack never
    // sees the pre-reload controller — and because the stale ctx.ui closures
    // keep working (setWidget has no assertActive), its self-rescheduling 1Hz
    // tick would otherwise outlive the session forever, pushing
    // setWidget(undefined) over the new session's frames: the agent tree
    // blinks off/on at the combined tick rate, worse with every reload.
    stack.fleetWidget?.dispose();
    stack.keepalive?.dispose();
    // consult cache-thread plan §7 (①): FIRST path — delete every retained thread head and clear the ledger
    // before the drain below; any consult still settling arrives at a closed registry and can only delete.
    // pi's /reload sends reason "reload" through here before re-importing the extension.
    stack.consult.close();
    stack.quota?.dispose();
    stack.dynamic?.dispose(ctx); // P1-4：flush 遥测观察窗 + 估计量落盘（T-D3-DISPOSE）
    stack.load?.dispose();
    stack.scheduler.stop(); // X5
    stack.rpc.close(); // X8
    // bash-timeout-grace plan §2.5 step 4/6 (P5): abort whichever recovery/
    // cleanup phase this stack still has outstanding — covers the fresh-
    // module `/reload` case (buildSessionStack's own module-level handoff
    // only sees a same-module rebuild).
    stack.bashJobRecovery?.dispose();
    // Fabric must freeze before run shutdown so late verdicts from the old
    // stack cannot write into the shared outbox; the next stack owns pending records.
    stack.fabric?.dispose();
    const drainMs = Math.min(settings.budget.abortGraceMs * 3, 15_000);
    // Background workflows (docs/dev/workflow-background/plan.md §4): request a stop on every
    // running workflow first (so no script spawns another child), then stop runs; both drains
    // share one bound. seal() finalizes any workflow still settling with its degraded snapshot
    // — its notice is persisted into THIS session while it is still current.
    stack.workflow.runs.shutdown();
    const pending = stack.query
      .list()
      .filter((s) => !["completed", "failed", "timed_out", "aborted"].includes(s.status));
    // admitted-run-visibility fix (2026-10-08 incident): spawn.abort() (unlike query.stop(),
    // which calls straight into the runtime adapter's activeCancels map) also falls back to
    // the admission-time AbortController wired into start() when the runtime adapter does not
    // know this runId yet — the exact state a just-admitted, not-yet-entered resume is in. Gated
    // on `running.has(runId)` (SpawnService's own admission-time truth), same as fix 1/2 above.
    await Promise.all(pending.map((s) => stack.spawn.abort(s.runId, "shutdown")));
    await Promise.all([
      stack.query.waitAll({ runIds: pending.map((s) => s.runId), waitMs: drainMs }),
      stack.workflow.runs.drain(drainMs),
    ]);
    // run-persistence plan D5: synchronous best-effort journal flush for runs the drain did not
    // settle — written into THIS session while pi has not yet invalidated the ctx.
    stack.runJournal.flushPending(
      pending.map((s) => s.runId),
      event.reason,
    );
    stack.workflow.runs.seal();
    // workflow-worktree plan D13 (v2.1 condition 2): tear down THIS stack's
    // spawn-service worktree waiters/timers, flip the runtime-adapter's
    // write-back to redirect-only, and release its disposition-sink
    // registration. Placed after seal() (same ordering rationale as the
    // fabric-before-workflow-shutdown note above): any run this stack is
    // still settling must get its chance to write through the normal path
    // first; only truly late reports after this point are redirected.
    stack.worktreeLate?.dispose();
    // workflow-worktree plan §3 (P4 fix, 2026 review): stop this stack's fire-and-forget
    // startup orphan scan from ever firing a notify after shutdown — same rationale as
    // worktreeLate.dispose() just above (a scan still resolving when the session ends must
    // never surface a stale prompt into a torn-down UI).
    stack.worktreeOrphansStartup?.dispose();
    // child-bash no-host-view diag plan (L1 todo #20): covers the fresh-
    // module `/reload` case the same way as worktreeOrphansStartup just
    // above — idempotent, so this and buildSessionStack's own top-of-build
    // release can never double-release.
    stack.hostBashViewCapability.dispose();
    // bash auto-background §3.7: reload/new/resume/fork always keep the
    // processes (the next stack adopts them); only a real `quit` consults
    // shutdownPolicy, and even `kill` is bounded best-effort — a background
    // job that refuses to die must never delay pi's exit.
    if (stack.bashJobs && event.reason === "quit" && settings.bashJobs.shutdownPolicy === "kill") {
      await killBashJobsBounded(stack.bashJobs, settings.budget.abortGraceMs);
    }
    // bash-timeout-grace plan §3.3 S6: same "only a real quit" gate as the
    // main session's own jobs above — a child subagent that is STILL
    // RUNNING when the main session merely `/reload`s must keep its
    // background jobs (they are not this stack's to kill); only when the
    // whole process is exiting does every still-registered child session's
    // bash jobs get a bounded best-effort kill.
    if (event.reason === "quit") {
      await getChildBashRegistry()
        .sealAll(BASH_JOB_SEAL_GRACE_MS)
        .catch(() => undefined);
    }
  });

  // Merged main-session modules are wired LAST: as standalone extensions
  // (pi.extensions order / user extensions dir) their hooks always ran after
  // the core ones, and tests (and possibly behavior) rely on the core
  // before_agent_start/session_start handlers staying first.
  // Merged HUD (plugin-merge): main-session TUI only — wireHud self-gates on
  // ctx.mode === "tui" (single HudSession.live flag) and cleans up its event
  // bus subscriptions on session_shutdown.
  if (settings.hud.enabled) wireHud(pi, { autoFetchMinutes: settings.hud.autoFetchMinutes });
  // Feishu notifications: main-session singleton (its own host guard stays as
  // defense-in-depth, now strictly redundant with the outer one). Post-guard
  // so child sessions never even load the card machinery.
  if (settings.feishuNotify.enabled) wireFeishuNotify(pi);
  // Session navigation: main-session TUI only (custom editor, session picker).
  // Post-guard like the HUD; self-gates the editor install on ctx.mode.
  if (settings.sessionNav.enabled) wireSessionNav(pi);
  // 会话标题模型生成 v2（任务 #12 + 随任务动态刷新）+ /title 命令：post-guard = 仅主会话
  // （TUI+RPC+json；子会话 print 模式在 HOST_KEY 早退，结构上不可达）；wireTitle 再自查
  // isChildSession 作双保险。title.enabled=false 时不接任何事件钩子（与旧行为逐字节一致），
  // 但 /title 命令始终注册（auto 如实拒绝、status 标注已禁用）。失败静默、在途互斥、过期
  // 结果隔离、所有权判定均由模块不变量保证。
  wireTitle(pi, {
    isChildSession,
    enabled: settings.title.enabled,
    model: settings.title.model,
    refreshEveryInputs: settings.title.refreshEveryInputs,
    refreshAfterMinutes: settings.title.refreshAfterMinutes,
    refreshWindowMinutes: settings.title.refreshWindowMinutes,
    maxRefreshes: settings.title.maxRefreshes,
  });
  // Deferred /reload: main-session only (post-guard). MUST be wired after
  // wireSessionNav — pi dispatches session_start handlers in registration
  // order, and this one's editor install reads getEditorComponent() to wrap
  // whatever session-nav installed (registration order = wrapping order).
  reloadRef.current = wireDeferredReload(pi, { settings, activeRunCount: activeSubagentRunCount });

  // topic-switch plan.md D2 flip point: a late-bound ref handed into `wireWebHub`'s `promptGate`
  // dep BEFORE the web-hub block runs, assigned to a real `PromptGatePort` only at the very end of
  // `activate()` (after `wireTopicSwitch` below) — web-hub always reads `promptGateRef.current` at
  // CALL time (never a stale snapshot), so the assignment order here only matters for readability.
  const promptGateRef: { current?: PromptGatePort } = {};

  // web-hub (plan 包 I): post-guard (child sessions stay inert), default off.
  // MUST be wired after wireDeferredReload so web-hub's session_start handler
  // runs after the stack rebuild and its fleet port can read holder.current.
  // Both the wiring and the command registration sit inside the enabled gate:
  // disabled ⇒ wireWebHub is never called, /webhub never registered, zero
  // network and zero disk (asserted by tests/integration/web-hub-disabled).
  if (settings.webHub.enabled) {
    // fabric wake §3.3 L7: late-bind the web ledger's attribution port into the (earlier-registered) input hook.
    wakeAttributeRef.current = (text) => webHubRef.current?.attributeInput(text);
    // web-hub-proxy (X1c): raw-block parse warnings for `/webhub status`, captured once at activate
    // (non-live, like `lanSettingsWarnings` below) and only when the proxy is enabled at all.
    const proxyWarnings = settings.webHub.proxy?.enabled === true ? loadWebHubProxyWarnings() : [];
    webHubRef.current = wireWebHub(pi, {
      settings: settings.webHub,
      ...(xsEnabled
        ? {
            xs: {
              stack: () => (xsAttached ? holder.current?.xs : undefined),
              // Channel-plan §3.2/§6.4 (CHW): the three broadcast keys ride along only when channels are on;
              // the bridge writes them only into a named-channel frame (default-only frames stay byte-identical).
              memberLimits: () =>
                channelsOn
                  ? {
                      ...settings.fabric.crossSession.limits,
                      broadcastsOutPerHour: settings.fabric.crossSession.channels.broadcast.outPerHour,
                      broadcastMinIntervalMs: settings.fabric.crossSession.channels.broadcast.minIntervalS * 1000,
                      broadcastWakesOutPerHour: settings.fabric.crossSession.channels.broadcast.wakeOutPerHour,
                    }
                  : settings.fabric.crossSession.limits,
              hubSendsPerMin: () => settings.fabric.crossSession.limits.hubSendsPerMin,
              // Reply-plan §5.1: frozen per activate (non-live, §8.1); unset ⇒ pre-reply byte shape.
              replyEnabled: () => replyEnabled,
              // Channel-plan §3.1 (CHW): agent cap `xs.channel.v1` + hub-global broadcast params.
              channelsEnabled: () => channelsOn,
              channelsHubConfig: () => ({
                maxRecipients: settings.fabric.crossSession.channels.broadcast.maxRecipients,
                wakeMaxRecipients: settings.fabric.crossSession.channels.broadcast.wakeMaxRecipients,
              }),
              // Alias-plan §3.6/§4 (ALW): agent cap `xs.alias.v1` + `HubConfig.crossSession.alias` (AL2 deviation 1:
              // alias off ⇒ the key is never written ⇒ the spawned hub builds no table). Keys absent while off.
              ...(aliasOn
                ? {
                    aliasEnabled: () => true,
                    aliasHubConfig: () => ({
                      offlineLeaseH: settings.fabric.crossSession.alias.offlineLeaseH,
                      coolMin: settings.fabric.crossSession.alias.coolMin,
                      takeMinOfflineMin: settings.fabric.crossSession.alias.takeMinOfflineMin,
                    }),
                    // Q3: display-only one-shot notice (the bridge de-duplicates by (sessionId, lost.at)).
                    notifyAliasLost: (text: string) => {
                      try {
                        const ctx = notifyCapabilityCtx.current;
                        if (ctx?.hasUI && typeof ctx.ui?.notify === "function") ctx.ui.notify(text, "info");
                      } catch {
                        /* display hint only */
                      }
                    },
                  }
                : {}),
            },
          }
        : {}),
      feishuBot: settings.feishuBot,
      proxyWarnings: () => proxyWarnings,
      fleet: () => holder.current?.query.list() ?? [],
      query: () => holder.current?.query,
      mention: () =>
        createMentionRouteDeps({
          ...mentionRouteDeps,
          reportError: (message) =>
            pi.sendMessage({
              customType: "subagent:mention-error",
              content: message,
              display: true,
              details: { source: "mention" },
            }),
          notifySession: (notice) => pi.sendMessage(sessionNoticeMessage(notice)),
        }),
      askUserEnabled: () => settings.askUser.enabled,
      ownedCommandNames,
      // web-hub-slash-args plan §4.4 (P1): S-own completion source (see the creation site
      // near `ownedCommandNames` above).
      argCompleters,
      // todo-web plan §3.3 (T3): live todo closure for StatusInfo.todo (both gates
      // already implicit — this block only runs with webHub.enabled, and todoWiring
      // only exists with todo.enabled).
      ...(todoWiring ? { todo: () => todoWiring.getTodoSnapshot() } : {}),
      // bash-jobs-panel plan §3.8 (包 A, D3-4): late-bound bash-jobs source — `current()` re-reads
      // the holder on EVERY call (the stack rebuild swaps the manager per session_start, and an
      // activate/session_start-time capture would go stale after /new・/resume・/fork); `gen` is
      // the manager instance itself, `tail` binds the same instance so one generation's list and
      // tails can never mix. `bashJobsEnabled=false` ⇒ no port ⇒ the slot stays absent (D5).
      ...(bashJobsEnabled(settings)
        ? {
            bashJobs: {
              current: () => {
                const m = holder.current?.bashJobs;
                return m === undefined
                  ? undefined
                  : {
                      gen: m,
                      list: () => m.list(),
                      tail: (record: JobRecord) => readBashJobTail(m, record),
                    };
              },
              retentionMs: () => settings.bashJobs.retentionMs,
            },
          }
        : {}),
      // quota-web plan §2 (D3/D8): same late-bound-getter precedent as `todo` above. `holder.current`
      // is re-read on every call (session_start/⁄reload rebuilds the stack); `settings.webHub.quota`
      // defaults true, `false` ⇒ the getter is never threaded through at all (wireWebHub treats an
      // absent `deps.quota` as "feature off", so the sampler never runs and the wire field never
      // appears — byte-equal to the pre-feature shape).
      ...(settings.webHub.quota !== false ? { quota: () => holder.current?.quota?.verdicts() ?? [] } : {}),
      // external-agent quota-plan r2 §9A.4 (P7wa): auth-class problems (401/402/403) ride the
      // same gate — `holder.current.quota` is the QuotaService itself (K9); problems() is a
      // synchronous, family-deduped in-memory read.
      ...(settings.webHub.quota !== false ? { quotaProblems: () => holder.current?.quota?.problems() ?? [] } : {}),
      ...(settings.cacheTtl.keepalive
        ? {
            cacheKeepalive: () => {
              try {
                const ka = holder.current?.keepalive; // fetched every call: follows stack rebuilds
                return ka === undefined ? undefined : { report: ka.report(), ...cacheTtl.status() };
              } catch {
                return undefined;
              }
            },
          }
        : {}),
      ...(settings.load.enabled ? { load: { port: () => holder.current?.load?.port(), settings: settings.load } } : {}),
      // topic-switch plan.md §P3b.1 D2 flip point: removing this one line is the whole kill-switch
      // for web prompts ever being judged — web-hub then always takes its native dispatch path.
      promptGate: () => promptGateRef.current,
    });
    askUserRemoteRef.current = () => webHubRef.current?.askUserRemote();
    if (webHubRef.current.capture !== undefined) commandCaptureRef.current = webHubRef.current.capture;
    // §9.1/§2.4 diagnostic snapshot (invalid `extraHosts` tokens / `trustProxyFrom`↔`externalOrigins`
    // mismatch) — same non-live, activate-time capture as `settings` itself; without this the
    // production `/webhub status` never surfaced these settings-level warnings even though
    // `createWebHubCommand` has supported the `lanSettingsWarnings` seam since it was written.
    const lanSettingsWarnings = loadWebHubLanSettingsWarnings();
    pi.registerCommand(
      "webhub",
      createWebHubCommand({ control: () => webHubRef.current, lanSettingsWarnings: () => lanSettingsWarnings }),
    );
  }

  // topic-switch (docs/dev/topic-switch/plan.md): registered LAST in activate() — later than
  // mention/feishu/session-nav/web-hub's own `input` registration — so none of those handlers ever
  // see a message we ourselves re-injected as already "handled" by someone else first (arch §10's
  // registration-order table). `settings.topicSwitch.enabled:false` ⇒ `wireTopicSwitch` is never
  // called at all: zero handler registration, zero `/topic-switch` command, zero D2 assignment —
  // `promptGateRef.current` stays undefined and web-hub's native/hold dispatch path runs unchanged.
  if (settings.topicSwitch.enabled) {
    const topicSwitch = wireTopicSwitch(pi, {
      settings: () => settings.topicSwitch,
      titleModel: settings.title.model,
      warmth: cacheTtl.warmth,
      stack: () => {
        const stack = holder.current;
        if (!stack) return undefined;
        return {
          activeRuns: () => activeSubagentRunCount(),
          backgroundBash: () => stack.bashJobs?.backgroundJobCount() ?? 0,
          goalBusy: () => stack.goal.record?.state === "active" || stack.goal.record?.state === "paused",
        };
      },
      remote: () => askUserRemoteRef.current?.(),
    });
    xsFencePorts.topicSwitch = () => topicSwitch.fenceActive();
    promptGateRef.current = topicSwitch.webGate; // D2 flip point
  }
}

/** §3.7 `shutdownPolicy: "kill"` — signal every live job, wait at most `graceMs`. */
async function killBashJobsBounded(bashJobs: BashJobManager, graceMs: number): Promise<void> {
  const live = bashJobs
    .list()
    .filter((record) => !isTerminalJobStatus(record.status) || bashJobs.hasOpenLocalHandle(record.jobId));
  if (live.length === 0) return;
  const kills = Promise.allSettled(live.map((record) => bashJobs.kill(record.jobId).catch(() => undefined)));
  await Promise.race([kills, new Promise<void>((resolve) => systemClock.setTimer(Math.max(0, graceMs), resolve))]);
}

/**
 * Each session_start rebuilds the stack (ctx.sessionManager is only
 * available there); tools/command are registered once at activate() time,
 * so they forward every call through `holder.current` at call time rather
 * than closing over a specific instance. Explicit per-method forwarding
 * (not a Proxy) keeps `this` binding correct for methods like
 * QueryService.waitAll() that call other methods on `this` internally.
 */
/** D-M7: live root-child mention view shared by the @ autocomplete wrapper
 *  and `/agent status`. Reads through the holder at call time, so wrappers
 *  registered on an earlier session_start keep seeing the rebuilt stack. */
export function mentionAutocompleteEntries(holder: { current?: Stack }): readonly MentionAutocompleteEntry[] {
  const stack = holder.current;
  if (!stack) return [];
  const terminal = new Set(["completed", "failed", "timed_out", "aborted"]);
  return stack.mention.labels().flatMap((label) => {
    const target = stack.mention.resolve(label);
    // v2 hard constraint: only root-direct runs are mentionable (D-M7).
    if (!target || target.parent !== "root") return [];
    const status = stack.query.get(target.runId)?.status;
    return [
      {
        label,
        type: target.type,
        runId: target.runId,
        status: status === "running" ? "running" : status && terminal.has(status) ? "settled" : "other",
      } satisfies MentionAutocompleteEntry,
    ];
  });
}

/** Reply-plan §9.3/§9.6 (MW): project the fabric sender's outcome onto the mention layer's port
 *  shape. Anything the notices do not name (stale/changed origin, unreceivable, bad args, …) is an
 *  `error` carrying the sender's reason, with the sender's own effect (none ⇒ safe to retry). */
function mapMentionSendOutcome(
  out: Awaited<ReturnType<XsSender["message"]>>,
  maxPending: number,
): MentionSessionSendOutcome {
  const base = { effect: out.effect, ...(out.to !== undefined ? { to: out.to } : {}) };
  switch (out.status) {
    case "sent": {
      const dueAt = out.reply ? Date.parse(out.reply.dueAt) : Number.NaN;
      return {
        status: "sent",
        ...base,
        ...(out.reason !== undefined ? { reason: out.reason } : {}),
        ...(out.reply ? { requestId: out.reply.requestId } : {}),
        ...(Number.isFinite(dueAt) ? { replyDueAt: dueAt } : {}),
      };
    }
    case "no_target":
    case "ambiguous":
    case "reply_unsupported":
      return { status: out.status, ...base, ...(out.reason !== undefined ? { reason: out.reason } : {}) };
    case "reply_quota":
      return { status: "reply_quota", ...base, pendingReplies: maxPending };
    case "reply_unreceivable":
      return { status: "error", ...base, reason: `reply_unreceivable:${out.unreceivable ?? "unknown"}` };
    default:
      return { status: "error", ...base, reason: out.reason ?? out.code ?? out.status };
  }
}

function requireStack(holder: { current?: Stack }): Stack {
  if (!holder.current) throw new Error("pi-subagent: no active session yet");
  return holder.current;
}
/** todo #22 optimize-plan §7.0 (P0-b): projects the memory module's narrow
 *  `TidySpawnRequest` onto a real `SpawnRequest`, always forcing the P0-r
 *  readonly tool domain literal through untouched — `wireMemory`'s
 *  `TidyPort` is the only caller. */
function mapTidySpawnRequest(req: TidySpawnRequest): SpawnRequest {
  return {
    type: req.type,
    prompt: req.prompt,
    ...(req.label === undefined ? {} : { label: req.label }),
    ...(req.cwd === undefined ? {} : { cwd: req.cwd }),
    ...(req.modelOverride === undefined ? {} : { modelOverride: req.modelOverride }),
    ...(req.thinkingOverride === undefined ? {} : { thinkingOverride: req.thinkingOverride }),
    ...(req.totalMs === undefined ? {} : { budgetOverride: { totalMs: req.totalMs } }),
    ...(req.schema === undefined ? {} : { schema: req.schema }),
    ...(req.inputBudget === undefined ? {} : { inputBudget: req.inputBudget }),
    toolDomain: req.toolDomain,
    expectAck: req.expectAck,
    suppressDelivery: req.suppressDelivery,
  };
}
function forwardSpawn(holder: { current?: Stack }): SpawnService {
  return {
    spawn: (req) => requireStack(holder).spawn.spawn(req),
    spawnAndWait: (req) => requireStack(holder).spawn.spawnAndWait(req),
    abort: (runId, cause) => requireStack(holder).spawn.abort(runId, cause),
    waitAll: (opts) => requireStack(holder).spawn.waitAll(opts),
    waitOutcome: (runId, waitMs) => requireStack(holder).spawn.waitOutcome(runId, waitMs),
    expectsAck: (runId) => requireStack(holder).spawn.expectsAck(runId),
    // CC1: forwarded for parity with the rest of SpawnService; no caller yet
    // (the workflow orchestrator that will use this lands in M3.1+).
    stopChildrenOf: (parentId, cause) => requireStack(holder).spawn.stopChildrenOf(parentId, cause),
    resolveRun: (handle) => requireStack(holder).spawn.resolveRun(handle),
    resolveResume: (handle) => requireStack(holder).spawn.resolveResume(handle),
    successorOf: (sessionFile) => requireStack(holder).spawn.successorOf(sessionFile),
    setConcurrencyLimit: (n) => requireStack(holder).spawn.setConcurrencyLimit(n),
    slots: () => requireStack(holder).spawn.slots(),
    runningIds: () => requireStack(holder).spawn.runningIds(),
  };
}
function forwardResolveRun(holder: { current?: Stack }) {
  return (handle: string) => {
    const result = requireStack(holder).spawn.resolveRun?.(handle);
    if (!result) throw new Error("pi-subagent: run resolver unavailable");
    return result;
  };
}
function forwardQuery(holder: { current?: Stack }): QueryService {
  return {
    get: (runId) => requireStack(holder).query.get(runId),
    list: (filter) => requireStack(holder).query.list(filter),
    wait: (runId, opts) => requireStack(holder).query.wait(runId, opts),
    waitAll: (opts) => requireStack(holder).query.waitAll(opts),
    steer: (runId, text, origin) => requireStack(holder).query.steer(runId, text, origin),
    setModel: (runId, model, opts) => requireStack(holder).query.setModel(runId, model, opts),
    stop: (runId, cause) => requireStack(holder).query.stop(runId, cause),
    extendTimeout: (runId, extendMs, opts) => requireStack(holder).query.extendTimeout(runId, extendMs, opts),
  };
}
function forwardWorkflow(holder: { current?: Stack }): WorkflowToolDeps {
  return {
    get defaultBudget() {
      return requireStack(holder).workflow.defaultBudget;
    },
    runs: { start: (req) => requireStack(holder).workflow.runs.start(req) },
  };
}
/** Background workflow management for get_subagent_result / abort_subagent (plan §2.3). Lenient when no
 *  session exists yet: nothing resolves as a workflow, so the run path produces its usual error. */
function forwardWorkflowQuery(holder: { current?: Stack }): WorkflowQueryPort {
  return {
    resolve: (handle) => holder.current?.workflow.runs.resolve(handle) ?? { kind: "none" },
    resolveLabel: (handle) => holder.current?.workflow.runs.resolveLabel(handle) ?? { kind: "none" },
    get: (workflowId) => holder.current?.workflow.runs.get(workflowId),
    wait: (workflowId, opts) => requireStack(holder).workflow.runs.wait(workflowId, opts),
    stop: (workflowId, cause, opts) => requireStack(holder).workflow.runs.stop(workflowId, cause, opts),
    extend: (workflowId, extendMs, opts) => requireStack(holder).workflow.runs.extend(workflowId, extendMs, opts),
    activity: (workflowId) => holder.current?.workflow.activity.list().find((w) => w.workflowId === workflowId),
    snapshotOf: (runId) => holder.current?.query.get(runId),
    usageOf: (runId) => holder.current?.query.get(runId)?.diag.usage,
  };
}
/** bash auto-background: the current session's job manager (absent before the
 *  first session_start, or when the feature is off) — both bash tools read it
 *  at call time so they survive session rebuilds. */
function forwardBashJobs(holder: { current?: Stack }): () => BashJobManager | undefined {
  return () => holder.current?.bashJobs;
}
function forwardOrphans(holder: { current?: Stack }): OrphanRegistry {
  return {
    register: (r) => requireStack(holder).orphans.register(r),
    recordLateRecovered: (runId, gen) => requireStack(holder).orphans.recordLateRecovered(runId, gen),
    get recent() {
      return requireStack(holder).orphans.recent;
    },
    get totalCount() {
      return requireStack(holder).orphans.totalCount;
    },
    get lateRecoveredCount() {
      return requireStack(holder).orphans.lateRecoveredCount;
    },
    countInWindow: (ms) => requireStack(holder).orphans.countInWindow(ms),
    get byReason() {
      return requireStack(holder).orphans.byReason;
    },
    resetCircuit: (op) => requireStack(holder).orphans.resetCircuit(op),
  };
}
function forwardNotifier(holder: { current?: Stack }): Notifier {
  return {
    enqueue: (p, opts) => requireStack(holder).notifier.enqueue(p, opts),
    finalize: (runId, generation, patch) => requireStack(holder).notifier.finalize(runId, generation, patch),
    settleBatch: (keys, ok) => requireStack(holder).notifier.settleBatch(keys, ok),
    ack: (runId, generation, by) => requireStack(holder).notifier.ack(runId, generation, by),
    peek: (key) => requireStack(holder).notifier.peek(key),
    consume: (key, by) => requireStack(holder).notifier.consume(key, by),
    reconcile: (persisted) => requireStack(holder).notifier.reconcile(persisted),
    verifyPersisted: (keys) => requireStack(holder).notifier.verifyPersisted(keys),
    get stats() {
      return requireStack(holder).notifier.stats;
    },
    get degraded() {
      return requireStack(holder).notifier.degraded;
    },
    get ackedSuppressions() {
      return requireStack(holder).notifier.ackedSuppressions;
    },
  };
}
