import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initSecureDomain } from "./secure/domain.js";
import { secureGuardsNeeded, wireSecureGuards } from "./secure/guards.js";
import { registerSecureCommand, secureCommandWanted } from "./secure/command.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { systemClock } from "./core/clock.js";
import { wireCacheTtl } from "./cache-ttl/cache-ttl.js";
import { getProviderEvidenceStore } from "./cache-ttl/provider-evidence.js";
import type { SubagentExtensionPoints } from "./core/types.js";
import { assertCompatible, detectPiCapabilities } from "./adapters/pi-compat.js";
import { FABRIC_ENTRY_CUSTOM_TYPE, createFabricEntryRenderer } from "./adapters/fabric-entry-renderer.js";
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
import { mergeExtensionPoints } from "./extensions/registry.js";
import { buildSessionStack } from "./stack.js";
import {
  createTidyPort,
  forwardNotifier,
  forwardOrphans,
  forwardQuery,
  forwardResolveRun,
  forwardWorkflow,
  requireStack,
  type StackHolder,
} from "./holder.js";
import { registerSubagentTools } from "./tools/register.js";
import { createBackgroundCompletionEventHook, createNotificationReceiptHook } from "./delivery/stack-hooks.js";
import { readBashJobTail } from "./bash/notify.js";
import { registerCompactHooks, registerCompactTools } from "./compact-hint/register.js";
import { bashJobsEnabled, BASH_JOB_SEAL_GRACE_MS, killBashJobsBounded, registerBashTools } from "./bash/host.js";
import { createMentionRouteDeps } from "./mention/mention.js";
import { createMentionWiring, mentionAutocompleteEntries } from "./mention/wire.js";
import { createWakeInputHook } from "./fabric/wake-input.js";
import { createXsActivation } from "./fabric/xs/activate.js";
import { currentConnection } from "./web-hub/agent/connection.js";
import { createPiWorktreeExtension } from "./extensions/worktree.js";
import { worktreeRoot } from "./extensions/worktree-orphans.js";
import { publishBackgroundStatus } from "./service/background-status.js";
import { createResultToolActivation } from "./tools/result-tool-activation.js";
import { PendingHandoffStore } from "./context-switch/store.js";
import { createQuotaHintHook, QUOTA_AVAILABLE_ENTRY_TYPE } from "./quota/index.js";
import { parseSubscriptionProviders, pickAlternatives } from "./quota/gate.js";
import { getChildSwitchCapability } from "./context-switch/capability.js";
import type { JobRecord } from "./bash/types.js";
import { createStatusCommand } from "./commands/status.js";
import { createWebHubCommand } from "./commands/webhub.js";
import { wireWebHub, type WebHubControl } from "./web-hub/agent/index.js";
import { vaultPredicateOf, wireSchedule } from "./schedule/agent/wire.js";
import { installMessageScheduler, installScheduleOrphanGuard } from "./schedule/agent/message.js";
import type { ScheduleConfirm } from "./schedule/agent/confirm.js";
import { wireScheduleSurface } from "./schedule/agent/surface.js";
import { createScheduleCommand } from "./commands/schedule.js";
import { createScheduleTool } from "./tools/schedule-tool.js";
import { scheduleSection } from "./sysprompt/schedule-section.js";
import { renderXsMessage } from "./fabric/xs/render.js";
import { renderToolkitMessage, TOOLKIT_LABELLED_CUSTOM_TYPES } from "./ui/toolkit-message-renderer.js";
import { renderTaskStartedMessage, TASK_STARTED_CUSTOM_TYPE, createTaskCommand } from "./commands/task.js";
import { createGoalCommand } from "./goal/command.js";
import { createGoalLoopHook } from "./goal/hook.js";
import { persistGoalRecord } from "./goal/store.js";
import { createDisabledWorkflowToolStub, createWorkflowTool } from "./tools/workflow-tool.js";
import { registerWebSearchTool } from "./web-search/index.js";
import { wireDate } from "./date/index.js";
import { wireTodo } from "./todo/index.js";
import { wireMemory } from "./memory/index.js";
import { wireChildBashJobs } from "./bash/child.js";
import { wireChildSession } from "./child/wire.js";
import { markChildExtensionActivated } from "./child/activation-signal.js";
// traffic-merge T3（§2.3）：主会话在 activate 末尾、子会话在 guard 前。模块顶层零副作用
// （惰性 sqlite/page/jq，tests/integration/traffic-lifecycle-process.test.ts 钉住），import 安全。
import { assembleTrafficChild, assembleTrafficHost } from "./traffic/index.js";
import { getChildBashRegistry } from "./bash/child-registry.js";
import { createPromptSectionHub } from "./sysprompt/hub.js";
import { agentTypesSection, availableModelsSection } from "./sysprompt/core-sections.js";
import { wireHud } from "./hud/index.js";
import wireAskUser from "./ask-user/index.js";
import { wrapCommandApi, type CommandCapturePort } from "./commands/capture.js";
import type { CommandRecorder } from "./web-hub/agent/command-record.js";
import type { ArgCompleter } from "./web-hub/agent/command-complete.js";
import wireFeishuNotify from "./feishu-notify/index.js";
import { wireSessionNav } from "./session-nav/index.js";
import { wireTitle } from "./title/index.js";
import { wireDeferredReload, type DeferredReloadDeps } from "./reload/index.js";
import { createReloadCommandPort } from "./reload/command-port.js";
import { countActiveRuns, type DeferredReloadController } from "./reload/defer.js";
import type { AskUserRemotePort } from "./ask-user/remote.js";
import { wireTopicSwitch } from "./topic-switch/wire.js";
import type { PromptGatePort } from "./web-hub/agent/prompt-gate.js";
import { createLoadHintHook, createLoadHintState } from "./sysload/hook.js";

// Public package export (package.json exports "." → dist/index.js): kept stable across the move.
export { mentionAutocompleteEntries } from "./mention/wire.js";

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
  // data-encryption plan r4 §2.4 step 1: judge the encrypted-session domain FIRST — before any
  // settings read (the settings override in loadSettings and the TMPDIR / ARMORY_MEMORY_ROOT
  // redirection both depend on it). Frozen per process; child sessions and /reload reuse it.
  const secureDomain = initSecureDomain();
  const commandCaptureRef: { current?: CommandCapturePort } = {};
  // web-hub-cmd-history plan §4.3/§8.1 (A1): same late-bound-ref pattern as commandCaptureRef —
  // wrapCommandApi runs at activate()'s very first line, the recorder is only built inside
  // wireWebHub (post-guard, webHub.enabled ∧ cmdHistory), assigned right after it returns.
  const commandRecorderRef: { current?: CommandRecorder } = {};
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
  const pi = wrapCommandApi(
    rawPi,
    () => commandCaptureRef.current,
    ownedCommandNames,
    argCompleters,
    () => commandRecorderRef.current,
  );
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
  // data-encryption §2.4/§2.5: LOCKED gate + D3/D4 + cross-domain switch guards. Registered before
  // every other handler (first `handled`/`block`/`cancel` wins inside one extension); pre-guard so
  // child sessions get D3/D4 too. Plain without configured vaults ⇒ zero wiring (byte-identical).
  const secureGuards = secureGuardsNeeded(secureDomain)
    ? wireSecureGuards(pi, { domain: secureDomain, isChildSession })
    : undefined;

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
    // traffic-merge T3（§2.3）：子会话只注册录制钩子（含 agent_settled / cache_warming_decision），
    // 无命令/服务/重放；isActive = 进程内 toolkit claim 存活（主会话发布；secure 域 settings 已强制
    // enabled=false，这里双保险在 assemble 内部复查）。childSessions=false 只禁落库不禁改写归属（拍板①）。
    // 安全评审 #1：同一 AgentSession 重复加载的 toolkit 副本也会走到这里（HOST_KEY 只能判「非首个激活」），
    // 由 src/traffic 的会话槽准入（按 ctx.sessionManager 身份）保证每会话仅一套录制钩子生效。
    assembleTrafficChild(pi, { settings: preGuardSettings.traffic, cwd: process.cwd() });
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
  // data-encryption §2.2: the one read-only plugin command — only when there is something to report
  // (non-plain verdict, configured vaults, or an enabled-but-broken section). No `secure` section or
  // `secure.enabled=false` ⇒ command list unchanged (secure-off golden).
  if (secureCommandWanted(secureDomain))
    registerSecureCommand(pi, { domain: secureDomain, runtimeLock: () => secureGuards?.lockedReason() });
  const holder: StackHolder = {};
  const reloadRef: { current?: DeferredReloadController } = {};
  const isReloadPending = () => reloadRef.current?.pending ?? false;
  const webHubRef: { current?: WebHubControl } = {};
  const xsFencePorts: { topicSwitch?: () => boolean; goal?: () => boolean } = {};
  // child-context-switch plan.md §3.1: latest live session_start ctx (see the `onDisabled` alert below); declared
  // up here because the xs activation shares it (alias suggestions / alias-lost notice).
  const notifyCapabilityCtx: { current?: ExtensionContext } = {};
  const xs = createXsActivation({
    settings,
    holder,
    webHubRef,
    fencePorts: xsFencePorts,
    notifyCtx: notifyCapabilityCtx,
    // built much later in activate(); only read at `/fabric fence reset` time
    scheduleMessage: () => scheduleMessage,
  });
  xs.registerTriggerGuard(pi);
  // web-hub archive plan (docs/dev/web-hub/archive-report.md): re-seed the per-session archive
  // control off the CURRENT branch (session_tree / session_compact — the stack itself seeds at
  // build time). Never throws; a missing sessionManager degrades to "keep current state".
  const restoreArchive = (ctx: { sessionManager?: unknown } | undefined): void => {
    const archive = holder.current?.archive;
    if (archive === undefined) return;
    const sm = ctx?.sessionManager as { getBranch?: () => readonly unknown[] } | undefined;
    if (typeof sm?.getBranch !== "function") return;
    try {
      archive.restore(sm.getBranch() ?? []);
    } catch {
      /* keep current state */
    }
  };
  // web-hub archive plan: the archive control re-seeds on session_tree (the stack is NOT rebuilt
  // there) and session_compact — same restore points as todo's wiring, registered OUTSIDE the
  // xsEnabled blocks above so they run regardless of fabric.
  // result-tool rename: pi ≥ 1.3 restores the active tools from the transcript on resume / fork / `/tree`
  // and would leave get_run_result inactive for sessions recorded under the old name. Piggybacks on the
  // existing session_start / session_tree handlers (no new handler); see tools/result-tool-activation.ts.
  const activateResultTool = createResultToolActivation(pi);
  pi.on("session_tree", (_event, ctx) => {
    restoreArchive(ctx);
    activateResultTool(ctx);
  });
  pi.on("session_compact", (_event, ctx) => restoreArchive(ctx));
  xs.registerFenceHooks(pi);
  // todo #22 optimize-plan P0-b (§7's spawn port): reads the CURRENT session
  // stack, same late-bound `holder.current` pattern as `forwardSpawn` below.
  // Only reached for the main session — structurally guaranteed by the
  // HOST_KEY early-return above, so this never runs for a child session.
  memoryWiring?.attachTidy(createTidyPort(holder));
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
  registerCompactHooks(pi, { holder, handoffStore });
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
      // 可用播报持久化（2026-10-23 拍板，跨 /reload 去重）：custom entry 不进 LLM
      // 上下文；读回走 turn_end ctx 的 getBranch（hook 内部，每栈首轮一次）。
      persistAvailable: (keys) => pi.appendEntry(QUOTA_AVAILABLE_ENTRY_TYPE, { v: 1, keys }),
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

  // scheduled-reports A0 (plan r3 §3/§12): post-guard, after the compat gate; default off ⇒ never
  // wired (no hook, no disk, no cap, no HubConfig key). Per-session agents are built by
  // buildSessionStack; the old global cron engine is retired.
  const scheduleMessage = settings.schedule.enabled
    ? installMessageScheduler(pi, holder, {
        // Same wiring as the xs controller (fence windows / web resume exec / topic-switch / goal / root wake).
        fencePorts: {
          webExec: () => webHubRef.current?.webExecBusy?.() === true,
          topicSwitch: () => xsFencePorts.topicSwitch?.(),
          goal: () => xsFencePorts.goal?.(),
        },
        rootWakeBusy: () => holder.current?.xs?.controller?.busy === true,
        attributeInput: () => wakeAttributeRef.current,
        // sched_bound (§7.5): the hub's key for THIS session; undefined (no hub) ⇒ no frame.
        agentKey: () => currentConnection()?.status().agentKey,
      })
    : undefined;
  // Feature off: only the orphan guard (hooks, zero IO, no tool/command/prompt/HubConfig change) — a trigger
  // that was already pending across a /reload that switched the feature off is still aborted on sight.
  if (!settings.schedule.enabled) installScheduleOrphanGuard(pi);
  const scheduleWiring = settings.schedule.enabled
    ? {
        ...wireSchedule(pi, {
          settings: settings.schedule,
          agentDir: getAgentDir(),
          secure: secureDomain,
          lockedReason: () => secureGuards?.lockedReason(),
          webHub: settings.webHub.enabled && settings.webHub.control !== false,
          current: () => holder.current?.schedule,
          // #61 C2: the confirm module lives on the surface (declared just below; this closure only
          // runs at sched_decide / hello_ack time, long after both are initialized).
          confirm: (): ScheduleConfirm | undefined => scheduleSurface?.confirm(),
        }),
        ...(scheduleMessage !== undefined ? { message: scheduleMessage } : {}),
      }
    : undefined;
  // scheduled-reports A3 (plan r3 §5): the session-visible surface. Tool / section / status bar / digest
  // exist ONLY when schedule.enabled (default off ⇒ tool table, command table, system prompt and status bar
  // byte-identical); `/schedule` is registered only then too (plan §1).
  const scheduleSurface = scheduleWiring
    ? wireScheduleSurface(pi, {
        settings: settings.schedule,
        types,
        current: () => holder.current?.schedule,
        revokeQueued: (taskId) => void scheduleMessage?.revokeTask(taskId),
      })
    : undefined;
  // Result notes (A1): the quiet-period proof runs on every settle (late-bound — the stack owns the executor).
  if (scheduleWiring !== undefined) pi.on("agent_settled", () => holder.current?.scheduleBackground?.notes.settled());
  if (scheduleSurface !== undefined) {
    pi.registerTool(
      createScheduleTool({
        agent: () => holder.current?.schedule,
        ports: (agent, ctx) => scheduleSurface.opsPorts(agent, ctx),
        confirm: () => scheduleSurface.confirm(),
      }),
    );
    pi.registerCommand(
      "schedule",
      createScheduleCommand({
        enabled: () => settings.schedule.enabled,
        agent: () => holder.current?.schedule,
        ports: (agent, ctx) => scheduleSurface.opsPorts(agent, ctx),
        confirm: () => scheduleSurface.confirm(),
        inVault: vaultPredicateOf(secureDomain),
        // `/schedule repair` is the local-only escape for a stuck dispatcher when fabric/xs (and its
        // `/fabric fence reset`) is not enabled; web policy keeps `repair` denied (frozen S0 table).
        resetBlockers: () => scheduleMessage?.resetBlockers(),
      }),
    );
  }

  xs.registerSurface(pi);
  if (caps.canRenderEntries) {
    // Renderer lives in adapters/fabric-entry-renderer.ts and renders ONLY
    // delivered records: the fabric outbox store appends one entry per state
    // transition, and rendering each one duplicated every fabric message in
    // the chat (pending/claimed appends + delivered append).
    // The header shows only the sender (@name): the record's persisted
    // fromLabel first, then the mention label, then the raw runId.
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
  registerSubagentTools(pi, { holder, settings, caps, isReloadPending });
  // HOST_KEY guard above means this registration is visible only in the main session.
  registerCompactTools(pi, {
    holder,
    settings,
    handoffStore,
    ...(todoWiring?.getTrackerSnapshot ? { todoTracker: todoWiring.getTrackerSnapshot } : {}),
  });
  // bash auto-background (§2.6/R6): the same-name `bash` override and its
  // `bash_job` management tool exist only when the feature is on — off means
  // pi's built-in bash stays in place with zero behaviour change.
  if (bashJobsEnabled(settings)) registerBashTools(pi, { holder, settings });
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
  // scheduled-reports A3: last section in the fold order (memory → types → models → schedules); session-scoped,
  // so a fork never inherits the parent's tasks. Absent when schedule is off ⇒ the prompt hub is untouched.
  if (scheduleWiring !== undefined)
    promptHub.register("pi_schedules", scheduleSection({ agent: () => holder.current?.schedule }));
  // CC3/M3.6: the workflow engine stays entirely inert (stub tool, clear
  // error message) unless settings.workflow.enabled — decided once here
  // rather than per-session, since `settings` itself is loaded once.
  pi.registerTool(
    settings.workflow.enabled
      ? createWorkflowTool(forwardWorkflow(holder, isReloadPending))
      : createDisabledWorkflowToolStub(),
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
          ? { stack, capability: xs.capabilityState(), outCap: settings.fabric.crossSession.limits.sendsOutPerHour }
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
      reload: createReloadCommandPort(() => reloadRef.current, pi),
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
    // Display-only label `[toolkit:x]` instead of `[subagent:x]` (customType names are persisted data).
    for (const type of TOOLKIT_LABELLED_CUSTOM_TYPES) pi.registerMessageRenderer(type, renderToolkitMessage);
  }

  const mention = createMentionWiring({ settings, holder, xs, webHubRef, notifyCtx: notifyCapabilityCtx });
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
  mention.install(pi);

  pi.on("session_start", async (_event, ctx) => {
    activateResultTool(ctx);
    const nextXsSessionId = xs.beginSessionStart(ctx);
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
      xs.defensiveTeardown(nextXsSessionId);
      holder.current.backgroundCompletions.dispose();
      holder.current.fleetWidget?.dispose();
      holder.current.archive?.dispose(); // web-hub archive plan: stop the stale auto-sweep (dual-path with buildSessionStack)
      holder.current.keepalive?.dispose();
      holder.current.quota?.dispose();
      holder.current.external?.dispose(); // external-agent plan §5.5（P5）：停目录探测（与 /reload 重建双保险）
      holder.current.dynamic?.dispose(ctx); // P1-4：防御性清理（与 shutdown 双保险，幂等）
      holder.current.load?.dispose();
      holder.current.schedule?.dispose(); // defensive: the next stack recovers this epoch's runs (unknown(reload))
      holder.current.scheduleBackground?.dispose();
      holder.current.rpc.close();
      holder.current.fabric?.dispose();
      holder.current.workflow.runs.abandon(); // stop orphaned background workflows; their notices are dropped
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
      xs.stackInput(),
      scheduleWiring,
    );
    holder.current = stack;
    xs.attach(stack, ctx, pi, nextXsSessionId);
    mention.attachAutocomplete(ctx);
    stack.notifier.reconcile();
    // Background workflows (plan §3.2): notices the previous stack persisted while shutting down.
    stack.workflow.redeliverPendingNotices();
    stack.fabric?.pump(); // RC5: synchronous, never blocks startup
    // scheduled-reports A0: interactive plain sessions only (the agent's mode matrix decides; secure /
    // locked / print / child / --no-session never arm). Never awaited: sweep/recovery take the ledger
    // lock (bounded) and must not delay session start.
    // A3: the surface starts the agent, then the status bar and the opening digest (needs the swept ledger).
    void scheduleSurface?.start(ctx, stack.schedule);
    // A1: cross-process note proof / re-delivery for results a previous process left pending (idle only).
    void stack.scheduleBackground?.notes.flush();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const stack = holder.current;
    if (!stack) return;
    // ask-user-async §3.3 (P2): FIRST — the hub stops broadcasting before the
    // drain/seal below settles anything; completions surfacing during shutdown
    // must not interrupt whatever session comes next. Idempotent (the next
    // buildSessionStack's top-of-build dispose is the same call).
    stack.backgroundCompletions.dispose();
    // scheduled-reports A0 (§4.6): the schedule executor goes FIRST — dispose, then this epoch's
    // non-terminal runs become unknown(owner-closed) (lock wait ≤ 500 ms) BEFORE the run drain
    // below can land a shutdown `aborted` (first terminal write wins).
    scheduleSurface?.shutdown(); // status bar cleared + digest disposed BEFORE the executor closes its runs
    await stack.schedule?.shutdown();
    stack.scheduleBackground?.dispose(); // AFTER closeEpoch wrote unknown(owner-closed): late outcomes only append lateOutcome
    // X7b: kill the fleet widget FIRST and unconditionally. pi's /reload
    // re-imports this extension as a fresh module (jiti moduleCache:false), so
    // the module-level previousFleetWidget handoff in buildSessionStack never
    // sees the pre-reload controller — and because the stale ctx.ui closures
    // keep working (setWidget has no assertActive), its self-rescheduling 1Hz
    // tick would otherwise outlive the session forever, pushing
    // setWidget(undefined) over the new session's frames: the agent tree
    // blinks off/on at the combined tick rate, worse with every reload.
    stack.fleetWidget?.dispose();
    stack.archive?.dispose(); // web-hub archive plan: same fresh-module /reload rationale as the widget above
    stack.keepalive?.dispose();
    stack.quota?.dispose();
    stack.dynamic?.dispose(ctx); // P1-4：flush 遥测观察窗 + 估计量落盘（T-D3-DISPOSE）
    stack.load?.dispose();
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
      ...xs.webHubDeps(),
      feishuBot: settings.feishuBot,
      // scheduled-reports A0: present ⇔ schedule.enabled ∧ plain domain (router exists).
      ...(scheduleWiring?.webHubPort !== undefined ? { schedule: scheduleWiring.webHubPort } : {}),
      proxyWarnings: () => proxyWarnings,
      fleet: () => holder.current?.query.list() ?? [],
      query: () => holder.current?.query,
      mention: () =>
        createMentionRouteDeps({
          ...mention.routeDeps,
          reportError: (message) =>
            pi.sendMessage({
              customType: "subagent:mention-error",
              content: message,
              display: true,
              details: { source: "mention" },
            }),
          notifySession: (notice) => pi.sendMessage(mention.sessionNoticeMessage(notice)),
        }),
      askUserEnabled: () => settings.askUser.enabled,
      ownedCommandNames,
      // web-hub-cmd-history plan §4.3/§5.4 (A1, M1): the recorder's pre-write LOCKED query.
      // Unassigned (plain domain without guards) ⇒ the deps stay unset ⇒ treated as writable.
      secureRecheckForWrite: (c) => secureGuards?.recheckForWrite(c),
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
      // web-hub archive plan: late-bound archive control (undefined while no live stack /
      // web-hub off — the `archived` status slot then stays absent and the op settles
      // E_UNSUPPORTED). Built per session by buildSessionStack, same lifecycle as bashJobs.
      archive: () => holder.current?.archive,
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
    // web-hub-cmd-history plan §8.1 (A1): the recorder rides the same ref the capture does —
    // undefined while cmdHistory is off (getRecorder then always answers undefined ⇒
    // wrapCommandApi keeps its byte-identical passthrough branch).
    if (webHubRef.current.recorder !== undefined) commandRecorderRef.current = webHubRef.current.recorder;
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

  // traffic-merge T3（§2.3/§2.4）：**activate 末尾**注册（cache-ttl 之后 ⇒ 录到最终 payload；认领
  // 协议同步执行：external-active ⇒ 整体让位零注册，否则发布 claim + session_start 权威复核）。
  // enabled=false（默认）/ secure 域 ⇒ assembleTrafficHost 首行即返回，零注册零 IO 零全局符号。
  assembleTrafficHost(pi, { settings: settings.traffic, cwd: process.cwd() });
}
