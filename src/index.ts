import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { systemClock } from "./core/clock.js";
import { wireCacheTtl } from "./cache-ttl/cache-ttl.js";
import { MemoryOutboxStore, MemoryRunStore } from "./core/store.js";
import type { RunSnapshot, SubagentExtensionPoints, UsageDelta } from "./core/types.js";
import { assertCompatible, detectPiCapabilities, probeReadBackEntries } from "./adapters/pi-compat.js";
import { createPiOutboxStore } from "./adapters/pi-outbox-store.js";
import { FABRIC_ENTRY_CUSTOM_TYPE, createFabricEntryRenderer } from "./adapters/fabric-entry-renderer.js";
import { wrapWithRunLog } from "./adapters/pi-run-log.js";
import { createAgentTypeRegistry } from "./config/agent-types.js";
import {
  defaultSettingsPath,
  loadSettingsFromFile,
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
  createNotificationReceiptHook,
  type Stack,
} from "./stack.js";
import { installMentionInput } from "./mention/mention.js";
import { createMentionAutocompleteProvider, type MentionAutocompleteEntry } from "./mention/autocomplete.js";
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
import { createSessionFactsProvider } from "./context-switch/session-facts.js";
import { createSetCompactThresholdTool } from "./tools/set-compact-threshold-tool.js";
import { createBashTool } from "./tools/bash-tool.js";
import { createBashJobTool } from "./tools/bash-job-tool.js";
import type { BashJobManager } from "./bash/manager.js";
import { isTerminalJobStatus } from "./bash/types.js";
import { createStatusCommand } from "./commands/status.js";
import { createWebHubCommand } from "./commands/webhub.js";
import { wireWebHub, type WebHubControl } from "./web-hub/agent/index.js";
import { renderTaskStartedMessage, TASK_STARTED_CUSTOM_TYPE, createTaskCommand } from "./commands/task.js";
import { createGoalCommand } from "./goal/command.js";
import { createGoalLoopHook } from "./goal/hook.js";
import { persistGoalRecord } from "./goal/store.js";
import { createDisabledWorkflowToolStub, createWorkflowTool } from "./tools/workflow-tool.js";
import { registerWebSearchTool } from "./web-search/index.js";
import { wireTodo } from "./todo/index.js";
import { wireMemory } from "./memory/index.js";
import { wireChildBashJobs } from "./bash/child.js";
import { getChildBashRegistry } from "./bash/child-registry.js";
import { createPromptSectionHub } from "./sysprompt/hub.js";
import { agentTypesSection, availableModelsSection } from "./sysprompt/core-sections.js";
import { wireHud } from "./hud/index.js";
import wireAskUser from "./ask-user/index.js";
import wireFeishuNotify from "./feishu-notify/index.js";
import { wireSessionNav } from "./session-nav/index.js";
import { wireDeferredReload, type DeferredReloadDeps } from "./reload/index.js";
import type { DeferredReloadController } from "./reload/defer.js";
import type { WorkflowToolDeps } from "./tools/workflow-tool.js";
import type { WorkflowQueryPort } from "./tools/workflow-target.js";

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
export default function activate(pi: ExtensionAPI): void {
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

  if (preGuardSettings.webSearch.enabled) registerWebSearchTool(pi);
  // todo-nudge (L1 feature): the tracker only turns on for the main session
  // with todo.nudge.enabled; sendMessage matches the compact-hint/quota-hint
  // hidden-message shape (display:false, triggerTurn:false, never sendUserMessage).
  const todoWiring = preGuardSettings.todo.enabled
    ? wireTodo(pi, {
        isChildSession,
        nudge: preGuardSettings.todo.nudge,
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
  if (preGuardSettings.memory.enabled)
    wireMemory(pi, { settings: preGuardSettings.memory, isChildSession, sections: promptHub });

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
  const releaseBackgroundStatus = publishBackgroundStatus(() => {
    const stack = holder.current;
    // Background workflows count as running subagent work (between child runs they have no live run).
    const runningSubagents = stack
      ? stack.query.list().filter((snapshot) => ["queued", "starting", "running", "stopping"].includes(snapshot.status))
          .length + stack.workflow.activity.list().length
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

  // Merged ask_user (plugin-merge): HOST-SESSION ONLY. A child subagent session
  // runs in print mode (createAgentSession never binds a UI/mode), so the tool
  // could only ever return the headless error there — registering it merely put
  // a doomed tool in every subagent's tool list. Deliberately placed BEFORE the
  // compat gate: ask_user is independent of the subagent core, so a disabled
  // core (bad pi version) must not take it down.
  if (settings.askUser.enabled) wireAskUser(pi);

  wireCacheTtl(pi, settings, {
    keepalive: () => holder.current?.keepalive,
    adaptive: () => holder.current?.adaptive,
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
  // context-switch（docs/dev/context-switch/context-switch-plan.md）：工具与
  // session_before_compact 钩子之间的交接槽。每次 activate() 新建（/reload 后必须干净）。
  const handoffStore = new PendingHandoffStore();
  pi.on(
    "turn_end",
    createCompactHintHook(holder, {
      sendMessage: (message, options) => pi.sendMessage(message, options),
      sendUserMessage: (text) => pi.sendUserMessage(text),
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
    }),
  );
  pi.registerTool(createSteerTool({ query: forwardQuery(holder), resolveRun: forwardResolveRun(holder) }));
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
      resolveRun: forwardResolveRun(holder),
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
          sendUserMessage: (text) => pi.sendUserMessage(text),
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
      pi.registerTool(createCompactTool({ sendUserMessage: (text) => pi.sendUserMessage(text) }));
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
      }),
    );
    pi.registerTool(createBashJobTool({ manager: forwardBashJobs(holder) }));
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
  const activeSubagentRunCount: DeferredReloadDeps["activeRunCount"] = () =>
    (holder.current?.query.list().filter((s) => !["completed", "failed", "timed_out", "aborted"].includes(s.status))
      .length ?? 0) + (holder.current?.workflow.activity.list().length ?? 0);
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
      // workflow-worktree plan §3 (P4 wt-orphans): always rescans the current stack's live
      // registry; before the first session_start (no stack yet) degrades to an empty scan
      // at the same default root the worktree extension itself uses.
      worktreeOrphans: () =>
        holder.current?.worktreeOrphans() ?? { root: worktreeRoot(), count: 0, capped: false, entries: [] },
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
  }

  // X6: @handle mentions. Registered once; resolves through the current
  // session's stack like the tools above. Conservative by contract: unknown
  // labels and @file/paths fall through to pi untouched.
  installMentionInput(pi, {
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

  pi.on("session_start", async (_event, ctx) => {
    if (compat.warning) console.warn(`[pi-subagent] ${compat.warning}`);
    // Defensive: if pi ever fires session_start without a paired shutdown,
    // stop the previous stack's timer/RPC surfaces so they cannot double-fire.
    if (holder.current) {
      holder.current.fleetWidget?.dispose();
      holder.current.keepalive?.dispose();
      holder.current.adaptive?.dispose();
      holder.current.quota?.dispose();
      holder.current.dynamic?.dispose(ctx); // P1-4：防御性清理（与 shutdown 双保险，幂等）
      holder.current.scheduler.stop();
      holder.current.rpc.close();
      holder.current.fabric?.dispose();
      holder.current.workflow.runs.abandon(); // stop orphaned background workflows; their notices are dropped
    }
    await types.reload();
    const stack = buildSessionStack(pi, ctx, settings, types, [mergeExtensionPoints(extensionPoints)], _event.reason);
    holder.current = stack;
    if (ctx.hasUI && typeof ctx.ui.addAutocompleteProvider === "function") {
      ctx.ui.addAutocompleteProvider((current) =>
        createMentionAutocompleteProvider(current, {
          entries: () => mentionAutocompleteEntries(holder),
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
    stack.adaptive?.dispose();
    stack.quota?.dispose();
    stack.dynamic?.dispose(ctx); // P1-4：flush 遥测观察窗 + 估计量落盘（T-D3-DISPOSE）
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
    await Promise.all(pending.map((s) => stack.query.stop(s.runId, "shutdown")));
    await Promise.all([
      stack.query.waitAll({ runIds: pending.map((s) => s.runId), waitMs: drainMs }),
      stack.workflow.runs.drain(drainMs),
    ]);
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
  // Deferred /reload: main-session only (post-guard). MUST be wired after
  // wireSessionNav — pi dispatches session_start handlers in registration
  // order, and this one's editor install reads getEditorComponent() to wrap
  // whatever session-nav installed (registration order = wrapping order).
  reloadRef.current = wireDeferredReload(pi, { settings, activeRunCount: activeSubagentRunCount });

  // web-hub (plan 包 I): post-guard (child sessions stay inert), default off.
  // MUST be wired after wireDeferredReload so web-hub's session_start handler
  // runs after the stack rebuild and its fleet port can read holder.current.
  // Both the wiring and the command registration sit inside the enabled gate:
  // disabled ⇒ wireWebHub is never called, /webhub never registered, zero
  // network and zero disk (asserted by tests/integration/web-hub-disabled).
  if (settings.webHub.enabled) {
    const webHubRef: { current?: WebHubControl } = {};
    webHubRef.current = wireWebHub(pi, {
      settings: settings.webHub,
      fleet: () => holder.current?.query.list() ?? [],
    });
    pi.registerCommand("webhub", createWebHubCommand({ control: () => webHubRef.current }));
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

function requireStack(holder: { current?: Stack }): Stack {
  if (!holder.current) throw new Error("pi-subagent: no active session yet");
  return holder.current;
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
    steer: (runId, text) => requireStack(holder).query.steer(runId, text),
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
