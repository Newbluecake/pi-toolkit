import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_BUDGET } from "../core/deadline.js";
import type { AgentTypeConfig, DeadlineBudget } from "../core/types.js";
import { DEFAULT_FABRIC_SETTINGS, parseFabricSettings } from "../fabric/settings.js";
import type { FabricSettings } from "../fabric/settings.js";
export type {
  FabricCrossSessionLimitsSettings,
  FabricCrossSessionSettings,
  FabricSettings,
  FabricWakeSettings,
  FabricXsAliasSettings,
  FabricXsBroadcastSettings,
  FabricXsChannelSettings,
  FabricXsReceiveMode,
  FabricXsReplySettings,
} from "../fabric/settings.js";
import {
  DEFAULT_FEISHU_BOT_SETTINGS,
  DEFAULT_WEBHUB_SETTINGS,
  parseFeishuBotBlock,
  parseWebHubLanBlock,
  parseWebHubLanValidation,
  parseWebHubProxyBlock,
  parseWebHubSettings,
  resolveWebHubPort,
} from "../web-hub/agent/settings.js";
import type {
  FeishuBotSettings,
  FeishuBotWarning,
  WebHubProxySettings,
  WebHubProxyWarning,
} from "../web-hub/agent/settings.js";
export type {
  FeishuBotParseResult,
  FeishuBotSettings,
  FeishuBotWarning,
  WebHubLanParseResult,
  WebHubProxyParseResult,
  WebHubProxySettings,
  WebHubProxyWarning,
} from "../web-hub/agent/settings.js";
import { dedupeLinkPaths } from "../extensions/worktree-link-paths.js";
import type { WorktreeSettings } from "../extensions/worktree-settings.js";
import { DEFAULT_CACHE_TTL_SETTINGS, parseCacheTtlSettings } from "../cache-ttl/settings.js";
import type { CacheTtlSettings } from "../cache-ttl/settings.js";
export type { CacheTtlMode, CacheTtlSettings } from "../cache-ttl/settings.js";
import { DEFAULT_QUOTA_SETTINGS, parseQuotaSettings } from "../quota/settings.js";
import type { QuotaSettings } from "../quota/settings.js";
export type { QuotaSettings, QuotaWindowThresholds } from "../quota/settings.js";
import { DEFAULT_LOAD_SETTINGS, parseLoadSettings } from "../sysload/settings.js";
import type { LoadSettings } from "../sysload/settings.js";
export type { LoadSettings, LoadHintSettings } from "../sysload/settings.js";
import {
  DEFAULT_COMPACT_SETTINGS,
  DEFAULT_DYNAMIC_THRESHOLD_SETTINGS,
  parseCompactSettings,
} from "../compact-hint/settings.js";
import type { CompactSettings } from "../compact-hint/settings.js";
export type { CompactSettings, DynamicThresholdSettings } from "../compact-hint/settings.js";
// TEMPORARY value re-export (#56 ⑧): `src/stack.ts` still imports it from here and is owned by 7b while this batch
// runs. After 7b merges, point stack.ts at "./compact-hint/settings.js" and delete this line (see the ⑧ report).
export { DEFAULT_DYNAMIC_THRESHOLD_SETTINGS };
import { DEFAULT_BASH_JOBS_SETTINGS, parseBashJobsSettings } from "../bash/settings.js";
import type { BashJobsSettings } from "../bash/settings.js";
export type { BashJobsSettings } from "../bash/settings.js";
import { DEFAULT_MEMORY_SETTINGS, parseMemorySettings } from "../memory/settings.js";
import type { MemorySettings } from "../memory/settings.js";
export type {
  ChildProfile,
  MemoryDoctorSettings,
  MemoryLayout,
  MemorySettings,
  MemoryTidySettings,
  MemoryToolSurface,
} from "../memory/settings.js";
import { DEFAULT_WORKFLOW_BUDGET, DEFAULT_WORKFLOW_SETTINGS, parseWorkflowSettings } from "../workflow/settings.js";
import type { WorkflowSettings } from "../workflow/settings.js";
export type { RunawayPolicy, WorkflowBudget, WorkflowSettings } from "../workflow/settings.js";
import { DEFAULT_TRAFFIC_SETTINGS, parseTrafficSettings } from "../traffic/settings.js";
import type { TrafficSettings } from "../traffic/settings.js";
export type { TrafficSettings, TrafficWebSettings } from "../traffic/settings.js";
import { DEFAULT_SCHEDULE_SETTINGS, parseScheduleSettings } from "../schedule/settings.js";
import type { ScheduleSettings } from "../schedule/settings.js";
export type { ScheduleSettings } from "../schedule/settings.js";
import { DEFAULT_EXTERNAL_AGENTS_SETTINGS, parseExternalAgentsSettings } from "../external-agent/settings.js";
import type { ExternalAgentsSettings } from "../external-agent/settings.js";
export type {
  DroidAgentSettings,
  DroidPricingOverride,
  ExternalAgentsSettings,
  ExternalProtocolCheck,
} from "../external-agent/settings.js";
import { parseEnabledGroup } from "./enabled-group.js";
import type { EnabledGroup } from "./enabled-group.js";
export type { EnabledGroup } from "./enabled-group.js";
import { DEFAULT_ASK_USER_SETTINGS, parseAskUserSettings } from "../ask-user/settings.js";
import type { AskUserSettings } from "../ask-user/settings.js";
export type { AskUserBackgroundInterruptSettings, AskUserSettings } from "../ask-user/settings.js";
import { DEFAULT_TODO_SETTINGS, parseTodoSettings } from "../todo/settings.js";
import type { TodoSettings } from "../todo/settings.js";
export type { TodoArchiveSettings, TodoNudgeSettings, TodoSettings } from "../todo/settings.js";
import { DEFAULT_HUD_SETTINGS, parseHudSettings } from "../hud/settings.js";
import type { HudSettings } from "../hud/settings.js";
export type { HudSettings } from "../hud/settings.js";
import { DEFAULT_GOAL_SETTINGS, parseGoalSettings } from "../goal/settings.js";
import type { GoalSettings } from "../goal/settings.js";
export type { GoalSettings } from "../goal/settings.js";
import { DEFAULT_TITLE_SETTINGS, parseTitleSettings } from "../title/settings.js";
import type { TitleSettings } from "../title/settings.js";
export type { TitleSettings } from "../title/settings.js";
import { DEFAULT_RELOAD_SETTINGS, parseReloadSettings } from "../reload/settings.js";
import type { ReloadSettings } from "../reload/settings.js";
export type { ReloadSettings } from "../reload/settings.js";
import { DEFAULT_SYSTEM_PROMPT_SETTINGS, parseSystemPromptSettings } from "../sysprompt/settings.js";
import type { SystemPromptSettings } from "../sysprompt/settings.js";
export type { SystemPromptSettings } from "../sysprompt/settings.js";
import { DEFAULT_EXTEND_SETTINGS, parseExtendSettings } from "../delivery/extend-settings.js";
import type { ExtendSettings } from "../delivery/extend-settings.js";
export type { ExtendSettings } from "../delivery/extend-settings.js";
import { DEFAULT_AGENT_DISPATCH_SETTINGS, parseAgentDispatchSettings } from "../service/dispatch-settings.js";
import type { AgentDispatchSettings } from "../service/dispatch-settings.js";
export type { AgentDispatchSettings } from "../service/dispatch-settings.js";
import { migrateTimeUnitsToSeconds, normalizeTimeUnits, secondsKeyOf } from "./time-units.js";
import { getSecureDomain, statePathsOf } from "../secure/domain.js";
import { resolveAgentDir } from "../core/agent-dir.js";
import {
  healSettingsFileLocked,
  migrateLegacySettingsFile,
  resolveSettingsLocation,
  withSettingsFileLock,
  writeSettingsFileAtomic,
  type SettingsLocation,
  type SettingsMigrationOutcome,
} from "../secure/settings-lock.js";

// web-hub (plan 包 I): the settings type is owned by package D; `import type`
// only, so this pre-guard module never loads the web-hub runtime graph.
import type {
  WebHubLanSettings,
  WebHubSettings as AgentWebHubSettings,
  WebHubSpawnSettings,
} from "../web-hub/agent/index.js";
import type { WebHubLanSettingsWarnings } from "../commands/webhub.js";

/** The agent-side `WebHubSettings` (owned by `web-hub/agent/index.ts`; `proxy?` is folded in there, X1c). */
export type WebHubSettings = AgentWebHubSettings;
export type { WebHubLanSettings, WebHubSpawnSettings };
// web-hub LAN (S1-W3 LI, lan-plan.md §9.1): host-token / origin classification is W1-frozen and
// shared by every layer that needs to agree on what counts as a valid host — settings validation
// (here, L16 第一处) is one of those layers, alongside `hub/main.ts`'s `parseHubLanConfig` (L16
// 第二处) and the request pipeline. Pure functions only, no pi import, no side effects.

// topic-switch plan.md P1 "settings.ts": config/settings.ts imports ONLY this module for the
// `topicSwitch` block — it owns the interface, the frozen defaults and the never-throws parser.
import {
  DEFAULT_TOPIC_SWITCH_SETTINGS,
  parseTopicSwitchSettings,
  type TopicSwitchSettings,
} from "../topic-switch/settings.js";
export type { TopicSwitchSettings };

export interface AgentSettings {
  concurrencyLimit: number;
  /** L1 (agent-tool pool-full plan §2): Agent tool pool-full dispatch policy. */
  agent: AgentDispatchSettings;
  budget: DeadlineBudget;
  deliveryAttempts: number;
  deliveryBackoffMs: number;
  reconcileTtlMs: number;
  maxReconcileRounds: number;
  maxReconcileBatch: number;
  coalesceWindowMs: number;
  coalesceMaxBatch: number;
  ackWindowMs: number;
  rememberAgents: boolean;
  worktree: WorktreeSettings;
  /** X3: hard cap on nested-delegation depth (top-level run = depth 0). Exceeding this is rejected at spawn time as a config error, never silently truncated. */
  maxNestedDepth: number;
  /** X7b: always-on agent-tree widget pinned above the editor while subagent runs are active. Default true. */
  fleetWidget: boolean;
  /** How long entered/undeliverable terminal rows linger in the fleet tree. */
  fleetTerminalLingerMs: number;
  /** Hard fallback while a delivered notification awaits context entry. */
  fleetAwaitNotificationMs: number;
  /** Fleet 主行剩余时间低于该值时转 warn 色；0 = 关闭该预警层（arch §7.2）。 */
  fleetDeadlineWarnMs: number;
  /** Line budget for run lines below the fleet widget header (the agent tree is now a pi-tui component factory, not a string-array widget, so it is no longer clamped by pi's InteractiveMode.MAX_WIDGET_LINES=10). Clamped 1–40 (WIDGET_MAX_ROWS); non-integer/out-of-range falls back to the default (20). */
  fleetWidgetMaxRows: number;
  /** Max chars of a subagent result body returned to callers; 0 = unlimited. */
  resultMaxChars: number;
  /** CC3: workflow engine settings (M3.1+ feature surface). Default disabled. */
  workflow: WorkflowSettings;
  /** bash auto-background settings (§6). Enabled by default (R4). */
  bashJobs: BashJobsSettings;
  /** Model-triggered context compaction. */
  compact: CompactSettings;
  /** timeout-notify：超时宽限 + 延长（arch §7.2）。 */
  extend: ExtendSettings;
  /** Message fabric settings; disabled by default for the MVP gray rollout. */
  fabric: FabricSettings;
  cacheTtl: CacheTtlSettings;
  /** 额度感知派单（quota-plan §8.1）。 */
  quota: QuotaSettings;
  /** Load-aware dispatch（docs/dev/sysload/plan.md）：CPU/MEM/DISK 监控 + 派发闸门 + 阶梯提示。 */
  load: LoadSettings;
  /** /goal 目标驱动持续运行（goal-plan v4）。 */
  goal: GoalSettings;
  /** Merged plugins (plugin-merge): HUD footer takeover. Default on; `enabled:false` leaves pi's built-in footer untouched. */
  hud: HudSettings;
  /** web-hub browser UI (plan 包 I). Default OFF: when disabled there is zero wiring, zero network, zero disk. */
  webHub: WebHubSettings;
  /** Merged plugins: web_search tool (Codex/SerpAPI/Bocha/Tavily failover). Default on. */
  webSearch: EnabledGroup;
  /** [date] 注入（date 模块）：会话首轮 + 跨日 + 新一轮距上次注入 ≥1h 时注入当前日期与时刻（HH:MM，消息形式，不动系统提示）。Pre-guard，主/子会话都生效。Default on. */
  date: EnabledGroup;
  /** Merged plugins: TaskCreate/List/Get/Update/Delete + /tasklist + aboveEditor widget. Default on. */
  todo: TodoSettings;
  /** ask_user interactive question tool (main session only — child subagent sessions never see it). Default on. */
  askUser: AskUserSettings;
  /** Feishu notification cards (main-session singleton). Default on. */
  feishuNotify: EnabledGroup;
  /** Session navigation enhancements (/resume-recent, /clear, bare exit, resume-list titles). Main-session TUI only. Default on. */
  sessionNav: EnabledGroup;
  /** Merged plugins: cwd-keyed project memory (injection + memory tool + /mem). Pre-guard, child sessions included. Default on. */
  memory: MemorySettings;
  /** Deferred /reload while subagents are running. */
  reload: ReloadSettings;
  /** system prompt 稳定化（sysprompt-stable §3.2）：S1 只含 wakeReplay。 */
  systemPrompt: SystemPromptSettings;
  /** 会话标题模型生成（任务 #12）。Main-session only（post-guard 装配）。 */
  title: TitleSettings;
  /** topic-switch（docs/dev/topic-switch/plan.md）：新请求相关性识别 + 建议切新会话。Main-session
   *  only（post-guard 装配）。类型/默认值/解析器归 `src/topic-switch/settings.ts`（P1），这里只接入
   *  `*S ⇄ *Ms` 边界（见 TIME_SETTING_MS_PATHS）。 */
  topicSwitch: TopicSwitchSettings;
  /** 外部 agent（external-agent plan §2.8）：droid 执行后端。默认关闭 ⇒ 零接线、零行为变化。 */
  externalAgents: ExternalAgentsSettings;
  /** 飞书机器人（feishu-bot plan v2 §9）：hub 侧长连接 bot。默认关闭 ⇒ 零接线、零行为变化。 */
  feishuBot: FeishuBotSettings;
  /** 流量录制（traffic-merge plan §2.2）：默认 enabled=false ⇒ 零注册、零 IO、零全局符号。全部非 live（/reload 生效）。 */
  traffic: TrafficSettings;
  /** 定时任务（scheduled-reports plan r3 §10.3）：默认 enabled=false ⇒ 零面。全部非 live（/reload；涉及 hub 的还需 /webhub restart）。 */
  schedule: ScheduleSettings;
}

export const DEFAULT_SETTINGS: AgentSettings = {
  concurrencyLimit: 6,
  agent: DEFAULT_AGENT_DISPATCH_SETTINGS,
  budget: DEFAULT_BUDGET,
  deliveryAttempts: 3,
  deliveryBackoffMs: 1_000,
  reconcileTtlMs: 24 * 60 * 60 * 1_000,
  maxReconcileRounds: 3,
  maxReconcileBatch: 10,
  coalesceWindowMs: 0,
  coalesceMaxBatch: 8,
  ackWindowMs: 0,
  rememberAgents: true,
  worktree: { enabled: false, gitTimeoutMs: 30_000, linkPaths: [] },
  maxNestedDepth: 3,
  fleetWidget: true,
  fleetTerminalLingerMs: 5_000,
  fleetAwaitNotificationMs: 600_000,
  fleetDeadlineWarnMs: 60_000,
  fleetWidgetMaxRows: 20,
  resultMaxChars: 32_000,
  workflow: DEFAULT_WORKFLOW_SETTINGS,
  bashJobs: DEFAULT_BASH_JOBS_SETTINGS,
  compact: DEFAULT_COMPACT_SETTINGS,
  fabric: DEFAULT_FABRIC_SETTINGS,
  cacheTtl: DEFAULT_CACHE_TTL_SETTINGS,
  quota: DEFAULT_QUOTA_SETTINGS,
  load: DEFAULT_LOAD_SETTINGS,
  extend: DEFAULT_EXTEND_SETTINGS,
  goal: DEFAULT_GOAL_SETTINGS,
  hud: DEFAULT_HUD_SETTINGS,
  webHub: DEFAULT_WEBHUB_SETTINGS,
  webSearch: { enabled: true },
  date: { enabled: true },
  todo: DEFAULT_TODO_SETTINGS,
  askUser: DEFAULT_ASK_USER_SETTINGS,
  feishuNotify: { enabled: true },
  sessionNav: { enabled: true },
  memory: DEFAULT_MEMORY_SETTINGS,
  reload: DEFAULT_RELOAD_SETTINGS,
  systemPrompt: DEFAULT_SYSTEM_PROMPT_SETTINGS,
  title: DEFAULT_TITLE_SETTINGS,
  topicSwitch: { ...DEFAULT_TOPIC_SWITCH_SETTINGS },
  externalAgents: { droid: { ...DEFAULT_EXTERNAL_AGENTS_SETTINGS.droid } },
  feishuBot: { ...DEFAULT_FEISHU_BOT_SETTINGS, files: { ...DEFAULT_FEISHU_BOT_SETTINGS.files } },
  traffic: { ...DEFAULT_TRAFFIC_SETTINGS, web: { ...DEFAULT_TRAFFIC_SETTINGS.web } },
  schedule: { ...DEFAULT_SCHEDULE_SETTINGS },
};
export function mergeBudget(...overrides: Array<Partial<DeadlineBudget> | undefined>): DeadlineBudget {
  // D-11：totalMs 恒 > 0。某一层的 totalMs 非法（≤ 0 / 非有限数）时丢弃该层的
  // 这一个键（其余键保留），回退下一层；DEFAULT_BUDGET.totalMs = 1_800_000 是
  // 最后一层 ⇒ 返回值 totalMs 恒 > 0（tests/config/agent-config.test.ts 锁死）。
  const sane = overrides.map((o) => {
    if (o === undefined || !("totalMs" in o)) return o;
    if (typeof o.totalMs === "number" && Number.isFinite(o.totalMs) && o.totalMs > 0) return o;
    const { totalMs: _drop, ...rest } = o;
    return rest;
  });
  return { ...DEFAULT_BUDGET, ...sane.reduce((out, value) => ({ ...out, ...value }), {}) };
}
export function mergeSettings(base: Partial<AgentSettings> = {}, config?: AgentTypeConfig): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...base,
    budget: mergeBudget(DEFAULT_SETTINGS.budget, base.budget, config?.budgetOverride),
  };
}
/**
 * Every dotted path in `AgentSettings` that holds a **duration**, named in the
 * internal millisecond form. The settings *file* stores each of these under
 * `secondsKeyOf(path)` (`budget.idleMs` → `budget.idleS`) as integer seconds;
 * see `config/time-units.ts` for the boundary rules.
 *
 * Derived from the two budget defaults so a new timeout field cannot be added
 * without also being unit-converted (the only hand-written entries are the
 * flat ones). `budget.startupRetries` is a retry *count*, not a duration, and
 * is excluded by the `Ms` suffix test.
 */
export const TIME_SETTING_MS_PATHS: readonly string[] = [
  ...Object.keys(DEFAULT_BUDGET)
    .filter((k) => k.endsWith("Ms"))
    .map((k) => `budget.${k}`),
  "deliveryBackoffMs",
  "reconcileTtlMs",
  "coalesceWindowMs",
  "ackWindowMs",
  "fleetTerminalLingerMs",
  "fleetAwaitNotificationMs",
  "fleetDeadlineWarnMs",
  "worktree.gitTimeoutMs",
  "workflow.replayTtlMs",
  ...Object.keys(DEFAULT_WORKFLOW_BUDGET)
    .filter((k) => k.endsWith("Ms"))
    .map((k) => `workflow.budget.${k}`),
  "bashJobs.autoBackgroundMs",
  "bashJobs.drainTimeoutMs",
  "bashJobs.retentionMs",
  "bashJobs.timeoutGraceMs",
  "fabric.minIntervalMs",
  "fabric.progressTtlMs",
  "fabric.rootMinIntervalMs",
  "goal.evalTimeoutMs",
  "goal.untilCmdTimeoutMs",
  "goal.deliveryWatchdogMs",
  "memory.tidy.timeoutMs",
  "memory.tidy.batch.totalTimeoutMs",
  "cacheTtl.keepaliveIntervalMs",
  "quota.refreshMs",
  "quota.refreshHotMs",
  "quota.staleAfterMs",
  "quota.l3EtaMs",
  "quota.minIntervalMs",
  "quota.repeatMs",
  "quota.requestTimeoutMs",
  "load.sampleIntervalMs",
  "load.sustainMs",
  "load.recoverMs",
  "load.hint.repeatMs",
  "load.hint.minIntervalMs",
  "askUser.backgroundInterrupt.delayMs",
  "askUser.backgroundInterrupt.quietMs",
  "askUser.backgroundInterrupt.maxDeferMs",
  "askUser.backgroundInterrupt.reaskDwellMs",
  "topicSwitch.judgeTimeoutMs",
  "topicSwitch.confirmTimeoutMs",
  "topicSwitch.expirySlackMs",
  // JSON-only live-acceptance seam (plan.md P1 settings.ts): stored as `debugAssumedTtlS` in the
  // file, NOT listed in SETTING_SPECS (no /agent settings UI surface) — still needs the *S⇄*Ms
  // boundary so a hand-edited settings file round-trips.
  "topicSwitch.debugAssumedTtlMs",
  // 外部 agent（external-agent plan §2.8）：四个时长文件键存秒（*S）。
  "externalAgents.droid.catalogTtlMs",
  "externalAgents.droid.requestTimeoutMs",
  "externalAgents.droid.initTimeoutMs",
  "externalAgents.droid.killGraceMs",
  // 定时任务（scheduled-reports plan r3 §10.3）：文件键 `schedule.defaultTimeoutS` / `schedule.maxTimeoutS`（秒）。
  "schedule.defaultTimeoutMs",
  "schedule.maxTimeoutMs",
];

const TIME_SETTING_SECONDS_PATHS: ReadonlySet<string> = new Set(TIME_SETTING_MS_PATHS.map(secondsKeyOf));

/** True for the *storage/display* key of a duration field (`budget.idleS`, `ackWindowS`, …). */
export function isTimeSettingKey(secondsKey: string): boolean {
  return TIME_SETTING_SECONDS_PATHS.has(secondsKey);
}

/**
 * Parse a settings-file object into the internal (millisecond) `AgentSettings`.
 *
 * Time fields arrive as integer seconds under `*S` keys and are converted to
 * milliseconds up front by `normalizeTimeUnits`, so every field validator
 * below still reasons in milliseconds. Legacy `*Ms` keys are tolerated
 * silently here; `loadSettingsFromFile` is the one that WARNs and rewrites.
 */
export function loadSettings(source: unknown): AgentSettings {
  return applySecureDomainOverrides(parseSettingsSource(source));
}

/**
 * data-encryption plan r4 §2.4 step 2: an encrypted (secure) process forces in-vault roots and turns
 * off the toolkit's active pushes (D8), whatever the user file says; a locked process keeps D8 off
 * too. Both settings entry points (`loadSettingsFromFile` / `readSettingsNoMigrate`) end here.
 * Plain or no verdict (hub process, unit tests) ⇒ the SAME object back (byte-identical). Every
 * nested object touched is cloned — `DEFAULT_SETTINGS` is never mutated.
 */
function applySecureDomainOverrides(settings: AgentSettings): AgentSettings {
  const domain = getSecureDomain();
  if (domain === undefined || domain.kind === "plain") return settings;
  const out: AgentSettings = {
    ...settings,
    fabric: { ...settings.fabric, crossSession: { ...settings.fabric.crossSession, enabled: false } },
    externalAgents: { ...settings.externalAgents, droid: { ...settings.externalAgents.droid, enabled: false } },
    feishuNotify: { ...settings.feishuNotify, enabled: false },
    // traffic-merge plan §6：加密/锁定域禁止流量落库（唯一落库闸口 persist 另有每次复查）。
    traffic: { ...settings.traffic, enabled: false },
  };
  if (domain.kind === "secure") {
    const paths = statePathsOf(domain.vault);
    out.bashJobs = { ...settings.bashJobs, dir: paths.bashJobs };
    out.workflow = { ...settings.workflow, journalDir: paths.workflows };
  }
  return out;
}

function parseSettingsSource(source: unknown): AgentSettings {
  if (source === null || typeof source !== "object") return { ...DEFAULT_SETTINGS, budget: { ...DEFAULT_BUDGET } };
  const value = normalizeTimeUnits(source as Record<string, unknown>, TIME_SETTING_MS_PATHS);
  const budget =
    value.budget && typeof value.budget === "object" ? (value.budget as Partial<DeadlineBudget>) : undefined;
  return mergeSettings({
    concurrencyLimit:
      typeof value.concurrencyLimit === "number" && value.concurrencyLimit >= 0
        ? value.concurrencyLimit
        : DEFAULT_SETTINGS.concurrencyLimit,
    agent: parseAgentDispatchSettings(value.agent),
    budget: mergeBudget(budget),
    deliveryAttempts:
      typeof value.deliveryAttempts === "number"
        ? Math.max(1, value.deliveryAttempts)
        : DEFAULT_SETTINGS.deliveryAttempts,
    deliveryBackoffMs:
      typeof value.deliveryBackoffMs === "number"
        ? Math.max(0, value.deliveryBackoffMs)
        : DEFAULT_SETTINGS.deliveryBackoffMs,
    reconcileTtlMs:
      typeof value.reconcileTtlMs === "number" ? Math.max(0, value.reconcileTtlMs) : DEFAULT_SETTINGS.reconcileTtlMs,
    maxReconcileRounds:
      typeof value.maxReconcileRounds === "number"
        ? Math.max(0, value.maxReconcileRounds)
        : DEFAULT_SETTINGS.maxReconcileRounds,
    maxReconcileBatch:
      typeof value.maxReconcileBatch === "number"
        ? Math.max(1, value.maxReconcileBatch)
        : DEFAULT_SETTINGS.maxReconcileBatch,
    coalesceWindowMs:
      typeof value.coalesceWindowMs === "number" && Number.isFinite(value.coalesceWindowMs)
        ? Math.min(5_000, Math.max(0, value.coalesceWindowMs))
        : DEFAULT_SETTINGS.coalesceWindowMs,
    coalesceMaxBatch:
      typeof value.coalesceMaxBatch === "number" && Number.isFinite(value.coalesceMaxBatch)
        ? Math.max(1, Math.floor(value.coalesceMaxBatch))
        : DEFAULT_SETTINGS.coalesceMaxBatch,
    ackWindowMs:
      typeof value.ackWindowMs === "number" && Number.isFinite(value.ackWindowMs)
        ? Math.min(5_000, Math.max(0, value.ackWindowMs))
        : DEFAULT_SETTINGS.ackWindowMs,
    rememberAgents: typeof value.rememberAgents === "boolean" ? value.rememberAgents : DEFAULT_SETTINGS.rememberAgents,
    maxNestedDepth:
      typeof value.maxNestedDepth === "number" && value.maxNestedDepth >= 0
        ? Math.floor(value.maxNestedDepth)
        : DEFAULT_SETTINGS.maxNestedDepth,
    fleetWidget: typeof value.fleetWidget === "boolean" ? value.fleetWidget : DEFAULT_SETTINGS.fleetWidget,
    fleetTerminalLingerMs:
      typeof value.fleetTerminalLingerMs === "number" &&
      Number.isFinite(value.fleetTerminalLingerMs) &&
      value.fleetTerminalLingerMs >= 0
        ? value.fleetTerminalLingerMs
        : DEFAULT_SETTINGS.fleetTerminalLingerMs,
    fleetAwaitNotificationMs:
      typeof value.fleetAwaitNotificationMs === "number" &&
      Number.isFinite(value.fleetAwaitNotificationMs) &&
      value.fleetAwaitNotificationMs >= 0
        ? value.fleetAwaitNotificationMs
        : DEFAULT_SETTINGS.fleetAwaitNotificationMs,
    fleetDeadlineWarnMs:
      typeof value.fleetDeadlineWarnMs === "number" &&
      Number.isFinite(value.fleetDeadlineWarnMs) &&
      value.fleetDeadlineWarnMs >= 0
        ? value.fleetDeadlineWarnMs
        : DEFAULT_SETTINGS.fleetDeadlineWarnMs,
    fleetWidgetMaxRows:
      typeof value.fleetWidgetMaxRows === "number" &&
      Number.isInteger(value.fleetWidgetMaxRows) &&
      value.fleetWidgetMaxRows >= 1 &&
      value.fleetWidgetMaxRows <= 40
        ? value.fleetWidgetMaxRows
        : DEFAULT_SETTINGS.fleetWidgetMaxRows,
    resultMaxChars:
      typeof value.resultMaxChars === "number" && Number.isFinite(value.resultMaxChars) && value.resultMaxChars >= 0
        ? Math.floor(value.resultMaxChars)
        : DEFAULT_SETTINGS.resultMaxChars,
    worktree:
      value.worktree && typeof value.worktree === "object"
        ? {
            enabled: (value.worktree as Record<string, unknown>).enabled === true,
            gitTimeoutMs:
              typeof (value.worktree as Record<string, unknown>).gitTimeoutMs === "number"
                ? ((value.worktree as Record<string, unknown>).gitTimeoutMs as number)
                : DEFAULT_SETTINGS.worktree.gitTimeoutMs,
            linkPaths: dedupeLinkPaths((value.worktree as Record<string, unknown>).linkPaths, (raw, reason) =>
              console.warn(
                `[pi-subagent] worktree.linkPaths: dropping invalid entry ${JSON.stringify(raw)}: ${reason}`,
              ),
            ),
          }
        : { ...DEFAULT_SETTINGS.worktree },
    workflow: parseWorkflowSettings(value.workflow),
    bashJobs: parseBashJobsSettings(value.bashJobs),
    compact: parseCompactSettings(value.compact),
    fabric: parseFabricSettings(value.fabric),
    cacheTtl: parseCacheTtlSettings(value.cacheTtl),
    quota: parseQuotaSettings(value.quota),
    load: parseLoadSettings(value.load),
    extend: parseExtendSettings(value.extend),
    goal: parseGoalSettings(value.goal),
    hud: parseHudSettings(value.hud),
    webHub: parseWebHubSettings(value.webHub),
    webSearch: parseEnabledGroup(value.webSearch, DEFAULT_SETTINGS.webSearch),
    date: parseEnabledGroup(value.date, DEFAULT_SETTINGS.date),
    todo: parseTodoSettings(value.todo),
    askUser: parseAskUserSettings(value.askUser),
    feishuNotify: parseEnabledGroup(value.feishuNotify, DEFAULT_SETTINGS.feishuNotify),
    sessionNav: parseEnabledGroup(value.sessionNav, DEFAULT_SETTINGS.sessionNav),
    memory: parseMemorySettings(value.memory),
    reload: parseReloadSettings(value.reload),
    systemPrompt: parseSystemPromptSettings(value.systemPrompt),
    title: parseTitleSettings(value.title),
    topicSwitch: parseTopicSwitchSettings(value.topicSwitch),
    externalAgents: parseExternalAgentsSettings(value.externalAgents),
    feishuBot: parseFeishuBotBlock(value.feishuBot).feishuBot,
    traffic: parseTrafficSettings(value.traffic),
    schedule: parseScheduleSettings(value.schedule),
  });
}

/**
 * Where the user-level settings file lives right now (docs/dev/settings-rename/plan.md §3.3): the
 * agentDir (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) × the file name (`pi-toolkit.json`, legacy
 * `pi-subagent.json`). Pure read — never migrates (see `prepareSettingsFile`). With the variable unset
 * the directory is the historical `~/.pi/agent`.
 */
export function settingsLocation(): SettingsLocation {
  return resolveSettingsLocation(resolveAgentDir(process.env, homedir()));
}

/** Default user-level settings file: `<agentDir>/pi-toolkit.json` (or the legacy name while unmigrated). */
export function defaultSettingsPath(): string {
  return settingsLocation().path;
}

/** Editor-title suffix naming where a non-default settings file came from (undefined for the default scope). */
export function settingsPathNote(location: SettingsLocation): string | undefined {
  if (location.scope === "inherited") return "inherited from ~/.pi/agent";
  if (location.scope === "agentDir") return "PI_CODING_AGENT_DIR";
  return undefined;
}

export interface SettingsFileReport {
  /** The settings file to load / edit (after any migration). */
  path: string;
  location: SettingsLocation;
  migration: SettingsMigrationOutcome;
  /** Set by the stack once `notices` were surfaced (once per activation; lives on the activate closure's report). */
  notified: boolean;
  /** User-facing warnings for the first session_start (S6b conflict, ignored relative PI_CODING_AGENT_DIR). */
  notices: readonly string[];
}

/**
 * The main session's ONE settings-file migration point (legacy `pi-subagent.json` → `pi-toolkit.json`,
 * plan §3.4). Called only by `src/index.ts` after the HOST_KEY claim, so child sessions never reach it.
 * Synchronous, no timers; never throws — a failed migration just means the legacy name keeps being used.
 */
export function prepareSettingsFile(): SettingsFileReport {
  const notices: string[] = [];
  let migration: SettingsMigrationOutcome = { kind: "noop" };
  try {
    const agent = resolveAgentDir(process.env, homedir());
    if (agent.ignored) {
      const msg = "PI_CODING_AGENT_DIR is relative; toolkit settings/traffic stay under ~/.pi/agent";
      console.warn(`[pi-subagent] ${msg}`);
      notices.push(msg);
    }
    const before = resolveSettingsLocation(agent);
    migration = migrateLegacySettingsFile(dirname(before.path));
    switch (migration.kind) {
      case "migrated":
        console.warn(
          `[pi-subagent] settings moved: ${migration.from} → ${migration.to} (kept ${migration.from} as a compatibility symlink for older versions)`,
        );
        break;
      case "conflict": {
        const msg =
          `settings conflict: ${migration.newPath} and ${migration.legacyPath} both exist as separate files; using ${migration.newPath}. ` +
          `Merge your changes into pi-toolkit.json, then remove pi-subagent.json` +
          (migration.legacyNewer ? " (pi-subagent.json is the newer file — your latest edits may be there)" : "");
        console.warn(`[pi-subagent] ${msg}`);
        notices.push(msg);
        break;
      }
      case "skipped":
        if (migration.reason === "lock" || migration.reason === "io")
          console.warn(`[pi-subagent] settings rename postponed (${migration.detail}); still reading ${before.path}`);
        break;
      case "noop":
        break;
    }
    const location = migration.kind === "noop" ? before : resolveSettingsLocation(agent);
    return { path: location.path, location, migration, notified: false, notices };
  } catch {
    const location = settingsLocation();
    return { path: location.path, location, migration, notified: false, notices };
  }
}

/**
 * Load user settings from a JSON file. Missing file → defaults; malformed
 * file → WARN + defaults. Never throws.
 *
 * This is also the single migration point for the millisecond → second storage
 * rename (requirement 2): it is the only place that holds the raw JSON, the
 * file path, write access and a console at the same time. Legacy `*Ms` keys
 * are rewritten to integer-second `*S` keys, the user is told what happened,
 * and the file is written back so the migration runs once. A failed write-back
 * is only a WARN — the in-memory settings are already migrated.
 */
export function loadSettingsFromFile(path: string = defaultSettingsPath()): AgentSettings {
  try {
    const rawText = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const parsed: unknown = rawText !== undefined ? JSON.parse(rawText) : {};
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return loadSettings(parsed);
    const timed = migrateSettingsFileTimeUnits(parsed as Record<string, unknown>, path);
    const cache = migrateLegacyCacheTtlState(timed.value, path, join(dirname(path), "cache-ttl-state.json"));
    const changed = timed.changed || cache.changed;
    let writeSucceeded = true;
    if (changed) {
      // Atomic write (tmp + rename): this file is shared by every session in
      // the process tree, so a torn write would read back as malformed JSON
      // and silently reset all settings to defaults (review B1). data-encryption
      // P1 review #5: held under the cross-process settings lock, and skipped when
      // another writer changed the file since we read it (retried next time).
      const outcome = withSettingsFileLock(path, () => {
        // plan §3.4.1: heal a crash-window S6a BEFORE comparing/writing, so this write can never turn it
        // into the permanent conflict S6b. writeSettingsFileAtomic follows a symlinked settings file.
        healSettingsFileLocked(dirname(path));
        const now = existsSync(path) ? readFileSync(path, "utf8") : undefined;
        if (now !== rawText) throw new Error("the file changed while migrating");
        writeSettingsFileAtomic(path, JSON.stringify(cache.value, null, 2) + "\n");
      });
      if (!outcome.ok) {
        writeSucceeded = false;
        console.warn(
          `[pi-subagent] failed to write the migrated ${path}: ${outcome.error}; the migration will be retried next time.`,
        );
      }
    }
    if (cache.deleteLegacy && writeSucceeded) {
      try {
        rmSync(cache.legacyPath, { force: true });
      } catch (error) {
        console.warn(
          `[pi-subagent] failed to remove legacy cache TTL state ${cache.legacyPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // D-11：budget.totalS ≤ 0 不再是 "no cap"——加载层丢弃该值回退默认，这里 WARN 一次
    // （只警告不改写文件；mergeBudget 保证最终 totalMs 恒 > 0）。legacy *Ms 键已在
    // migrateSettingsFileTimeUnits 里转成 *S，此处只查 totalS 即可覆盖两种来源。
    const budgetBlock = (cache.value as Record<string, unknown>).budget;
    const rawTotalS =
      budgetBlock && typeof budgetBlock === "object" ? (budgetBlock as Record<string, unknown>).totalS : undefined;
    if (typeof rawTotalS === "number" && rawTotalS <= 0) {
      console.warn(`[pi-subagent] budget.totalS must be > 0 (got ${rawTotalS}); using the default 1800s`);
    }
    // Same rule for the workflow cap (BW10 is unsupported in background mode —
    // see parseWorkflowSettings): dropped at parse time, WARNed here once.
    const workflowBlock = (cache.value as Record<string, unknown>).workflow;
    const workflowBudget =
      workflowBlock && typeof workflowBlock === "object"
        ? (workflowBlock as Record<string, unknown>).budget
        : undefined;
    const rawWorkflowTotalS =
      workflowBudget && typeof workflowBudget === "object"
        ? (workflowBudget as Record<string, unknown>).workflowTotalS
        : undefined;
    if (typeof rawWorkflowTotalS === "number" && rawWorkflowTotalS <= 0) {
      console.warn(
        `[pi-subagent] workflow.budget.workflowTotalS must be > 0 (got ${rawWorkflowTotalS}); using the default ${
          DEFAULT_WORKFLOW_BUDGET.workflowTotalMs / 1000
        }s`,
      );
    }
    // replay-verify-plan D9: an illegal workflow.isolationReplay falls back to the
    // default ('verify') at parse time (parseWorkflowSettings), same as every other
    // choice/number field — but D9 requires an explicit WARN ("回落并 WARN"), unlike
    // the silent field-by-field fallback the rest of loadSettings uses. WARN here once,
    // mirroring the workflowTotalS pattern above.
    const rawIsolationReplay =
      workflowBlock && typeof workflowBlock === "object"
        ? (workflowBlock as Record<string, unknown>).isolationReplay
        : undefined;
    if (rawIsolationReplay !== undefined && rawIsolationReplay !== "verify" && rawIsolationReplay !== "off") {
      console.warn(
        `[pi-subagent] invalid workflow.isolationReplay ${JSON.stringify(rawIsolationReplay)} (expected "verify" or "off"); using the default "${DEFAULT_SETTINGS.workflow.isolationReplay}"`,
      );
    }
    return loadSettings(cache.value);
  } catch (error) {
    console.warn(
      `[pi-subagent] failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}; using defaults.`,
    );
    return loadSettings(undefined);
  }
}

/**
 * Read-only settings load (plugin-merge review B1): parses the file and
 * returns the effective settings but NEVER migrates, writes, or deletes
 * anything. This is the only loader safe to call before the HOST_KEY guard —
 * child subagent sessions re-activate this extension too, and the full
 * loadSettingsFromFile would concurrently write the shared settings file
 * (~/.pi/agent/pi-toolkit.json by default) from every child. Malformed/missing file →
 * defaults, silently: child sessions must not spam stderr with warnings the
 * main session already emitted. Legacy `*Ms` keys are still tolerated
 * (normalizeTimeUnits handles them in memory); the on-disk rewrite stays the
 * host's job via loadSettingsFromFile.
 */
export function readSettingsNoMigrate(path: string = defaultSettingsPath()): AgentSettings {
  try {
    if (!existsSync(path)) return loadSettings(undefined);
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return loadSettings(parsed);
  } catch {
    return loadSettings(undefined);
  }
}

/**
 * `webHub.lan` settings-level validation warnings (plan §9.1/§2.4), read directly off the
 * settings file the same way `readSettingsNoMigrate` does — read-only, never migrates/writes,
 * defaults (empty warnings) on any failure. `webHub.*` is a non-live, activate-time snapshot
 * (same as `AgentSettings.webHub` itself), so callers capture this once and reuse it; there is no
 * separate "raw settings" object kept around after `loadSettingsFromFile` returns, hence the
 * second (cheap, best-effort) file read rather than threading the raw JSON through `AgentSettings`
 * (which would widen a type several unrelated call sites depend on for no other reason than this
 * one diagnostic snapshot).
 */
export function loadWebHubLanSettingsWarnings(path: string = defaultSettingsPath()): WebHubLanSettingsWarnings {
  const empty: WebHubLanSettingsWarnings = { invalidExtraHosts: [], invalidAllowClients: [], proxyMismatch: false };
  try {
    if (!existsSync(path)) return empty;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    const webHubRaw = (parsed as Record<string, unknown>).webHub;
    if (webHubRaw === null || typeof webHubRaw !== "object" || Array.isArray(webHubRaw)) return empty;
    const record = webHubRaw as Record<string, unknown>;
    const { invalidExtraHosts, invalidAllowClients, proxyMismatch } = parseWebHubLanValidation(
      record.lan,
      resolveWebHubPort(record),
    );
    return { invalidExtraHosts, invalidAllowClients, proxyMismatch };
  } catch {
    return empty;
  }
}

/**
 * `webHub.proxy` parse warnings (`port-range-invalid` / `port-range-overlap` / `max-proxies-invalid`)
 * for `/webhub status` (web-hub-proxy plan v2 §5, X1c) — same read-only, never-migrates, defaults
 * on any failure contract as {@link loadWebHubLanSettingsWarnings}: `parseWebHubProxyBlock` itself
 * RETURNS its warnings (so repeated settings parses never spam logs) but `AgentSettings` keeps only
 * the effective values, so the diagnostic is recomputed from the raw block once per activate.
 */
export function loadWebHubProxyWarnings(path: string = defaultSettingsPath()): WebHubProxyWarning[] {
  try {
    if (!existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const webHubRaw = (parsed as Record<string, unknown>).webHub;
    if (webHubRaw === null || typeof webHubRaw !== "object" || Array.isArray(webHubRaw)) return [];
    const record = webHubRaw as Record<string, unknown>;
    const resolvedPort = resolveWebHubPort(record);
    const lanParsed = parseWebHubLanBlock(record.lan, resolvedPort);
    return parseWebHubProxyBlock(record.proxy, resolvedPort, lanParsed.lan.port).warnings;
  } catch {
    return [];
  }
}

/**
 * `feishuBot` parse warnings for `/webhub feishu status` (feishu-bot plan v2 §9) — same read-only,
 * never-migrates, `[]` on any failure contract as {@link loadWebHubProxyWarnings}: the effective
 * values live in `AgentSettings.feishuBot`, the diagnostic is recomputed from the raw block.
 */
export function loadFeishuBotWarnings(path: string = defaultSettingsPath()): FeishuBotWarning[] {
  try {
    if (!existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return parseFeishuBotBlock((parsed as Record<string, unknown>).feishuBot).warnings;
  } catch {
    return [];
  }
}

/**
 * Rewrite legacy millisecond keys in a just-read settings file to the new
 * integer-second keys, WARN about every conversion/drop, and persist the
 * result. Returns the migrated object (used even when the write fails).
 * Never throws — same field-level tolerance as the rest of the loader.
 */
function migrateSettingsFileTimeUnits(
  raw: Record<string, unknown>,
  path: string,
): { value: Record<string, unknown>; changed: boolean } {
  const migration = migrateTimeUnitsToSeconds(raw, TIME_SETTING_MS_PATHS);
  if (!migration.changed) return { value: raw, changed: false };
  if (migration.converted.length)
    console.warn(
      `[pi-subagent] ${path}: time settings are now stored in seconds; migrated ${migration.converted.length} key(s): ${migration.converted.join(", ")}`,
    );
  for (const warning of migration.warnings) console.warn(`[pi-subagent] ${path}: ${warning}`);
  return { value: migration.value, changed: true };
}

function migrateLegacyCacheTtlState(
  raw: Record<string, unknown>,
  settingsPath: string,
  legacyPath: string,
): { value: Record<string, unknown>; changed: boolean; deleteLegacy: boolean; legacyPath: string } {
  if (!existsSync(legacyPath)) return { value: raw, changed: false, deleteLegacy: false, legacyPath };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(legacyPath, "utf8"));
  } catch (error) {
    console.warn(
      `[pi-subagent] failed to read legacy cache TTL state ${legacyPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { value: raw, changed: false, deleteLegacy: false, legacyPath };
  }
  const mode =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).mode
      : undefined;
  if (mode !== "auto" && mode !== "on" && mode !== "off" && mode !== "adaptive") {
    console.warn(`[pi-subagent] invalid legacy cache TTL mode in ${legacyPath}; keeping the file for retry`);
    return { value: raw, changed: false, deleteLegacy: false, legacyPath };
  }
  if (Object.hasOwn(raw, "cacheTtl")) {
    const existing = raw.cacheTtl;
    const existingMode =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>).mode
        : undefined;
    if (existingMode !== "auto" && existingMode !== "on" && existingMode !== "off" && existingMode !== "adaptive")
      console.warn(`[pi-subagent] ${settingsPath}: invalid cacheTtl setting preserved; using auto`);
    return { value: raw, changed: false, deleteLegacy: true, legacyPath };
  }
  if (mode === "adaptive") console.warn('[pi-subagent] legacy cache TTL mode "adaptive" was removed; using auto');
  return {
    value: { ...raw, cacheTtl: { mode: mode === "adaptive" ? DEFAULT_SETTINGS.cacheTtl.mode : mode } },
    changed: true,
    deleteLegacy: true,
    legacyPath,
  };
}

/**
 * Persist a single settings override to the user settings file (backs
 * `/agent settings set|reset` and the TUI editor). `dottedKey` is a *storage*
 * path like "budget.idleS" or "worktree.enabled" — duration keys use their
 * second-valued `*S` name; value === undefined removes the override (and
 * prunes parent objects left empty). Other fields are preserved. Returns an
 * error message on failure, undefined on success; never throws — a
 * malformed existing file is reported rather than silently clobbered.
 */
export function persistSettingOverride(dottedKey: string, value: unknown, explicitPath?: string): string | undefined {
  // data-encryption P1 review #5: the whole re-read → merge → write runs under the cross-process
  // settings lock shared with the `pi-secure` launcher; a lock failure refuses the write.
  // plan §3.4.1: lock → heal → resolve the target → atomic write. With no explicit path the target is
  // resolved INSIDE the lock, after the heal (it can change: S6a→S5 keeps NEW, an unsupported symlink
  // reverts to LEGACY); an explicit path (tests) is written as given, its directory healed first.
  const lockPath = explicitPath ?? defaultSettingsPath();
  let path = lockPath;
  const outcome = withSettingsFileLock(lockPath, (): string | undefined => {
    healSettingsFileLocked(dirname(lockPath));
    if (explicitPath === undefined) {
      path = defaultSettingsPath();
      // The directory chose a different lock file meanwhile (e.g. a settings file appeared under the
      // agentDir): we do not hold that lock — refuse rather than write unlocked.
      if (dirname(path) !== dirname(lockPath)) return `${path}: settings location changed while writing; retry`;
    }
    let raw: Record<string, unknown> = {};
    try {
      if (existsSync(path)) {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
          return `${path}: top-level value is not an object; not modifying it`;
        raw = parsed as Record<string, unknown>;
      }
    } catch (error) {
      return `${path}: ${error instanceof Error ? error.message : String(error)}`;
    }
    const segments = dottedKey.split(".");
    let node: Record<string, unknown> = raw;
    for (const segment of segments.slice(0, -1)) {
      const child = node[segment];
      const next =
        child !== null && typeof child === "object" && !Array.isArray(child)
          ? { ...(child as Record<string, unknown>) }
          : {};
      node[segment] = next;
      node = next;
    }
    const leaf = segments[segments.length - 1]!;
    if (value === undefined) delete node[leaf];
    else node[leaf] = value;
    try {
      writeSettingsFileAtomic(path, JSON.stringify(raw, null, 2) + "\n");
      return undefined;
    } catch (error) {
      return `${path}: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
  return outcome.ok ? outcome.value : `${path}: ${outcome.error}`;
}
