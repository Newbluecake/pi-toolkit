import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_BUDGET } from "../core/deadline.js";
import type { AgentTypeConfig, DeadlineBudget, Millis } from "../core/types.js";
import { migrateTimeUnitsToSeconds, normalizeTimeUnits, secondsKeyOf } from "./time-units.js";
import {
  DEFAULT_FORCE_THRESHOLD_PERCENT,
  DEFAULT_HINT_THRESHOLD_PERCENT,
  DEFAULT_USAGE_TICK_STEP_PERCENT,
} from "../compact-hint/threshold.js";

/**
 * CC3 (workflow design §3.2/§8.2): forward-declared budget shape for the
 * future workflow engine (M3.1+). Only the *type* and its settings-surface
 * defaults are introduced in this milestone — no orchestrator, no runner, no
 * scripts. Field defaults mirror the WT1–WT19 timeout matrix (§4.1).
 */
export interface WorkflowBudget {
  /** WT1 */ scriptLoadMs: Millis;
  /** WT2 */ scriptSliceMs: Millis;
  /** WT3 */ workerBootMs: Millis;
  /** WT4 */ hostCallMs: Millis;
  /** WT6 */ gateMs: Millis;
  /** WT7 (0 = unlimited, still bounded by workflowTotalMs) */ phaseTotalMs: Millis;
  /** WT8 */ workflowTotalMs: Millis;
  /** WT9 (diagnostic only, see RunawayPolicy) */ heartbeatStallMs: Millis;
  /** WT10 */ abortGraceMs: Millis;
  /** WT11 */ terminateConfirmMs: Millis;
}
export const DEFAULT_WORKFLOW_BUDGET: WorkflowBudget = {
  scriptLoadMs: 5_000,
  scriptSliceMs: 2_000,
  workerBootMs: 10_000,
  hostCallMs: 60_000,
  gateMs: 600_000,
  phaseTotalMs: 0,
  workflowTotalMs: 3_600_000,
  heartbeatStallMs: 10_000,
  abortGraceMs: 10_000,
  terminateConfirmMs: 2_000,
};
/**
 * CC3/§2.3 HB2–HB5: heartbeat stall is a diagnostic/fast-detection signal,
 * never the hard termination guarantee (that's the absolute workflowTotalMs
 * deadline, CC4). "diagnose_only" (default) never terminates on stall alone.
 */
/**
 * Merged armory-memory (memory-plan §3.1): cwd-keyed project memory under
 * `~/.pi/agent/memory/<slug>/` — auto-injection, the `memory` tool, `/mem`.
 * Field-by-field tolerant parsing in `parseMemorySettings` (never throws,
 * parseBashJobsSettings 同款风格）。No duration fields ⇒ not in
 * TIME_SETTING_MS_PATHS.
 */
export interface MemorySettings {
  /** 总开关。false = 不注册注入 hook、memory 工具、/mem 命令。Default true（融合后原插件被卸载，默认关=升级即功能消失，merge-plan D2 哲学）。 */
  enabled: boolean;
  /** 子会话是否注入。Default true（对齐原插件：所有会话注入）。仅影响注入 hook；工具可见性仍由 agent type tools allowlist 决定。 */
  injectInChildSessions: boolean;
  /** 子会话是否允许 write/append。Default false（子会话只读；内置 Plan 类型的只读语义由此保证，无需改 agent-types.ts）。list 不受限。 */
  allowWriteInChildSessions: boolean;
  /** 写入成功后是否冻结本会话的注入块（true = 本会话后续轮次继续注入写入前的旧块、下个会话生效；false = 下轮立即重渲染生效）。Default false。取舍见 memory-plan §5.5。
   *  sysprompt-stable M3（plan §4.6）：保留为独立开关，不并入 hub 的快照冻结——二者作用在不同层：这个开关钳的是 provider 每轮返回的 Live 值本身
   *  （section provider 层），hub 的 stable snapshot 钳的是「Live 值折叠进开头的时机」（hub 层）。true 时 provider 连续多轮返回同一字节，hub 的
   *  resolveAtTurn 因 live === announced 天然不产生尾部更新消息，snapshot 会在下一次合法刷新点（如新会话）自然追上冻结内容——不需要额外接线。 */
  freezeInjectionAfterWrite: boolean;
  /** 内联全文的文件数上限（pin 优先）。0 = 只出索引。Default 3。 */
  inlineMax: number;
  /** 内联区总字节预算（UTF-8 字节）。0 = 只出索引。Default 4000。 */
  byteCap: number;
  /** 索引条数上限，超出出 "… +N more"。Default 15。 */
  indexMax: number;
  /** 单文件体积上限（write 替换后 / append 累加后）。Default 262_144（256KB）。 */
  maxFileBytes: number;
  /** 单次 write/append 的 content 字节上限。Default 65_536（64KB）；解析时 clamp 到 ≤ maxFileBytes。 */
  maxWriteBytes: number;
}

export type RunawayPolicy = "diagnose_only" | "terminate_on_stall";
export interface WorkflowSettings {
  /** Master switch; the workflow engine (M3.1+) is entirely inert while false. */
  enabled: boolean;
  budget: Partial<WorkflowBudget>;
  journalDir?: string;
  /** Default 7 days (§6.4 RP6); 0 = unlimited. */
  replayTtlMs: number;
  replayScope: "chain" | "content";
  runawayPolicy: RunawayPolicy;
}

/**
 * bash auto-background (§6): the `bashJobs` settings block backing the bash
 * tool override and its BashJobManager. Every field is validated field-by-field
 * by `parseBashJobsSettings` (never throws, illegal values fall back to the
 * default) exactly like `parseWorkflowSettings`.
 */
export interface BashJobsSettings {
  /** Foreground bash calls auto-background after this duration; 0 = whole feature off (no tool override registered). Default 290_000 — 4m50s, just under the 5-minute prompt-cache TTL, so the early return rarely triggers a cache-miss price jump (R2). */
  autoBackgroundMs: number;
  /** Per-job log file cap in bytes; older output is truncated past this. Default 10 MiB. */
  maxLogBytes: number;
  /** Hard cap on concurrently running background jobs (§3.8). Default 8. */
  maxBackgroundJobs: number;
  /** Terminal job records/log files are pruned after this age. Default 24h; <= 0 disables pruning. */
  retentionMs: number;
  /** Post-exit log drain cap. Invalid values fall back to the 30s default. */
  drainTimeoutMs: number;
  /** What to do with still-running jobs on session shutdown (§3.7). Default "keep". */
  shutdownPolicy: "keep" | "kill";
  /** Job state/log root; each session uses a sanitized child directory. */
  dir?: string;
  /** Shell used to run job commands; defaults to the $SHELL whitelist → bash (§3.3) when unset. */
  shellPath?: string;
}

/** 动态阈值（dynamic-threshold-plan.md §11.1）：价格/缓存感知的 switch_context 提醒线。 */
export interface DynamicThresholdSettings {
  /** 默认 "on"（用户拍板 D1；风险由 min 合成 + force 不动 + off 逐字节回归兑住）。shadow = 全量计算 + 遥测 + status，不改任何模型可见字节。 */
  mode: "off" | "shadow" | "on";
  /** 地板：默认 35（研究 §7.4）。 */
  minHintPercent: number;
  /** 质量上限：默认 60 —— 未校准的安全上限（D8）。 */
  maxQualityPercent: number;
  /** 再发现成本 R：默认 $10 —— 经验先验，未跨模型校准（D2/§5.1）。 */
  rediscoveryUsd: number;
  /** 价格未知时的退化模式：默认 "static"（最保守 = 不改变现行行为）。 */
  unknownPriceMode: "static" | "quality";
}

export interface CompactSettings {
  enabled: boolean;
  hintThresholdPercent: number;
  /** Force-compaction line. With `forceScaling` on (the default) this is the
   *  anchor for a 1M-token window; the effective line rises 5 points per
   *  decade of window shrinkage (1M→88, 200k→91, 37k→95) before the reserve
   *  cap clamps it below pi's own automatic compaction line. */
  forceAtPercent: number;
  /** Scale `forceAtPercent` with the model's context window. Default true;
   *  set false to use the configured percentage literally on every window. */
  forceScaling: boolean;
  /** Absolute hint threshold in units of k tokens (default 500 = 500k used
   *  tokens). 0 = no absolute limit (percent only). Auto-disabled when the
   *  line strictly exceeds the model's context window. When both the percent
   *  and the absolute line apply, whichever fires first wins. */
  hintThresholdTokens: number;
  /** Absolute force threshold in units of k tokens; 0 = no absolute limit
   *  (default). Same auto-disable rule as hintThresholdTokens. */
  forceAtTokens: number;
  /** Coarsest step (percent points) between lightweight usage-tick reports.
   *  The grid is non-linear — it densifies toward the force ceiling (step/2
   *  within 2 steps of it, step/5 within 1) so reminders get more frequent as
   *  the threshold approaches. 0 disables ticks. Keeps the model aware of
   *  context usage before the reminder fires. */
  usageTickStepPercent: number;
  assumedReserveTokens?: number;
  /** 注册 `switch_context`（模型自写交接内容的上下文切换工具），并让 hint/force 层改为催它。
   *  Default true。false = 回到纯 compact_context 行为（docs/dev/context-switch/context-switch-plan.md §6）。 */
  switchTool: boolean;
  /** switchTool 开启时是否**同时**保留 `compact_context` 工具。Default false（彻底替换）。
   *  switchTool=false 时本项无意义：compact_context 总是注册。 */
  keepCompactTool: boolean;
  /** 越过强制线后，先硬性要求模型调用 `switch_context` 的次数；用完仍越线才回落到通用强制压缩。
   *  Default 1；0 = 不给机会，直接强制通用压缩。 */
  forceDemandTurns: number;
  /** 价格感知动态提醒线（docs/dev/compact-hint/dynamic-threshold-plan.md）。 */
  dynamicThreshold: DynamicThresholdSettings;
}

export type CacheTtlMode = "auto" | "on" | "off" | "adaptive";
export interface CacheTtlSettings {
  mode: CacheTtlMode;
  /** 保活总开关。Default true. */
  keepalive: boolean;
  /** ping 间隔（内部 ms；文件存 keepaliveIntervalS 秒）。Default 240_000 (240s)，钳位 [60s, 280s]。 */
  keepaliveIntervalMs: number;
  /** 每窗口硬上限；0 = 关闭。Default 11。 */
  keepaliveMaxPings: number;
  /** 前缀实测下界门槛（tokens）。Default 20000。 */
  keepaliveMinPrefixTokens: number;
  /** 允许「下一次必写请求」升级成 1h（§6.3）。Default true. */
  keepaliveUpgradeAfterBudget: boolean;
  /** adaptive 总开关（adaptive 方案 §7.1，默认启用）：true 时未显式写 mode 的默认解析为 "adaptive"；false ⇒ 回落 auto 且不咨询 adaptive service。 */
  adaptiveEnabled: boolean;
  /** 每会话 adaptive 升级引发的实测 cacheWrite 总预算（tokens）。Default 200000。 */
  adaptiveWriteBudgetTokens: number;
  /** 每会话 adaptive 升级的边际支出预算（美元，主闸；0 = 关闭美元闸、只看 token 预算）。
   *  累计口径：结算账本的 cost.cacheWrite × 0.375（5m→1h 边际占比，推导见 adaptive.ts
   *  MARGINAL_WRITE_FRACTION）。Default 1.0。 */
  adaptiveWriteBudgetUsd: number;
  /** 每会话「入场费」预算（tokens）：未被 1h 覆盖的首次升级会整条前缀重写，单列一档预算，
   *  不与 adaptiveWriteBudgetTokens（稳态边际）混算。0 = 永不开新前缀 ⇒ 整条升级路径关闭。
   *  Default 600000。 */
  adaptiveFeeBudgetTokens: number;
  /** 入场费的美元预算（0 = 关闭美元闸）。累计口径：cost.cacheWrite × 0.95（推导见 adaptive.ts
   *  ENTRY_FEE_MARGINAL_WRITE_FRACTION）。Default 3.0。 */
  adaptiveFeeBudgetUsd: number;
  /** 热升级允许的预测增量 Δ̂ 上限（tokens）。Default 32000。 */
  adaptiveMaxDeltaTokens: number;
  /** 距上次 1h 升级累计写入超过该值才允许再次热升级（tokens）。Default 16000。 */
  adaptiveRefreshAfterTokens: number;
  /** 每会话冷升级次数上限；0 = 禁用冷升级。Default 1。 */
  adaptiveColdUpgrades: number;
  /** 两次冷升级的最小间隔（内部 ms；文件存 adaptiveColdCooldownS 秒）。Default 1_200_000 (20min)，钳位 [60s, 7200s]。 */
  adaptiveColdCooldownMs: number;
  /** 冷升级要求的 subagent 最小剩余时域（内部 ms；文件存 adaptiveColdMinHorizonS 秒）。Default 600_000 (10min)。 */
  adaptiveColdMinHorizonMs: number;
  /** 是否启用 S4 历史长空档弱信号（只影响热升级）。Default true. */
  adaptiveHistoryGapSignal: boolean;
}

/**
 * consult（docs/dev/consult/plan.md §4.6，冻结面）：轮内同步请教。七个字段，
 * 逐字段容错解析见 parseConsultSettings（never throws）。预检与累计帽是
 * **两个**值（方案 §15 #4）：共用一个值时 est 可以合法逼近 cap（如 $1.9 / cap $2），
 * 第一个 turn 结束即越帽 ⇒ maxTurns 退化为 1；$2/$4 保证 est 打满预检线时仍余
 * ≥ 1 个同量级 turn 的预算（P0-α③ 实测：150k 上下文专家首请求 $1.23）。
 * 内部常量（故意不进 settings，防旋钮 creep）：FORK_TTL_MS = 24h、
 * CONSULT_MAX_CONTEXT_PERCENT = 75、CONSULT_MAX_GLOBAL_INFLIGHT = 8。
 */
export interface ConsultSettings {
  /** 总开关。false = 不注入 consult 工具；派发后被关则工具返回 unavailable nack。Default true。 */
  enabled: boolean;
  /** 请教 run 的总预算硬顶（budgetOverride.totalMs ⇒ maxTotalFactor=1，无宽限无延长）。Default 150s。 */
  timeoutMs: number;
  /** 回答截断上限（同时写进问题 prompt 的指令）。Default 2000。 */
  maxAnswerChars: number;
  /** 轮次上限：第 maxTurns+1 个 turn 开始时 abort（turn 边界判定）。Default 3。 */
  maxTurns: number;
  /** fork 前的首请求成本预检阈值（USD）；0 = 关闭预检。Default 2。 */
  maxFirstRequestUsd: number;
  /** 累计成本帽（USD，turn 边界判定）；0 = 关闭成本帽。Default 4。 */
  maxCostUsd: number;
  /** 每提问方 in-flight consult 上限。Default 2。 */
  maxConcurrent: number;
}

/**
 * 额度感知派单（docs/dev/quota/quota-plan.md §8.1）：阶梯预警 + spawn 闸门 +
 * HUD 的设置块。逐字段容错解析见 parseQuotaSettings（never throws）。时长
 * 字段（*Ms 内部毫秒、文件存 *S 秒）登记在 TIME_SETTING_MS_PATHS；阈值
 * 单调性（l1 <= l2 <= l3）在解析层钳制（§8.3）。baseUrl / userAgent 是
 * JSON-file-only 逃生阀，刻意不进 SETTING_SPECS（与 bashJobs.dir 同款）。
 */
export interface QuotaSettings {
  /** 总开关。false = 无 service、无钩子、无闸门（全特性一键回退，plan R11）。Default true。 */
  enabled: boolean;
  /** 逗号分隔的 provider id 白名单；空串 = 全部关闭。未知 id 静默忽略。 */
  providers: string;
  /**
   * 逗号分隔：没有额度接口、但实为订阅的 provider（如 copilot-anthropic）。替代链
   * 把它们与受管订阅同归「订阅」——有订阅可选时只推荐订阅。空串 = 无。
   */
  subscriptionProviders: string;
  /** 快照 TTL：早于此不重新请求。冷态 provider 使用该值。 */
  refreshMs: number;
  /** 热态 provider 的快照 TTL；非法或非正值回落默认值。 */
  refreshHotMs: number;
  /** 超过此龄的快照视为陈旧：只提示、闸门不阻断。 */
  staleAfterMs: number;
  /** L1 提示阈值（used %）。 */
  l1Percent: number;
  /** L2 建议阈值（used %）。 */
  l2Percent: number;
  /** L3 强烈阈值（used %）。 */
  l3Percent: number;
  /** ETA 低于此值直接判 L3。 */
  l3EtaMs: number;
  /** L1 tick 的 usedPct 网格步；0 = 关闭网格闸（只剩等级闩锁）。 */
  tickStepPercent: number;
  /** 两条 quota 消息之间的全局最小间隔（L3 不受限）。 */
  minIntervalMs: number;
  /** L2+ 的复读周期。 */
  repeatMs: number;
  /** 注入消息是否在 transcript 可见。 */
  display: boolean;
  /** spawn 闸门总开关。 */
  gate: boolean;
  /** 触发阻断的最低等级（2 = 更激进，3 = 默认）。 */
  gateLevel: number;
  /** HUD status key。 */
  hud: boolean;
  /** 单次 HTTP 超时。 */
  requestTimeoutMs: number;
  zaiBaseUrl: string;
  zaiOverseasBaseUrl: string;
  kimiBaseUrl: string;
  /** Cloudflare 需要浏览器 UA（Kimi 实测）。空串 = 用内置默认。 */
  userAgent: string;
}

/**
 * timeout-notify：超时宽限 + 延长设置（arch §7.2）。逐字段容错解析见
 * parseExtendSettings。
 */
export interface ExtendSettings {
  /** 总开关。false 时：不注册 extend_subagent_timeout 工具，且 spawn 合并后钳 maxExtensions = 0（D-16）。Default true. */
  enabled: boolean;
  /** 宽限通知投递策略：background = 跳过仍在前台阻塞宿主的 caller-ack run；always = 调试用（D-17）；off = 不发（宽限仍生效）。 */
  notify: "background" | "always" | "off";
}

/**
 * /goal 目标驱动持续运行（docs/dev/goal/goal-plan.md v4）。逐字段容错解析见
 * parseGoalSettings。时长字段（*Ms 内部毫秒、文件存 *S 秒）必须登记进
 * TIME_SETTING_MS_PATHS；maxMinutes 是分钟字段，不在时长规约内。
 */
export interface GoalSettings {
  /** Master switch；false 时 /goal 命令仍在但 hook 完全不评估。Default true. */
  enabled: boolean;
  /** 主动迭代轮数封顶（--max-turns 缺省值）。Default 20。 */
  maxTurns: number;
  /** wall-clock 封顶（分钟），在评估点检查、滞后一整轮（v4 M-h）；0 = 不限。Default 120。 */
  maxMinutes: number;
  /** 累计 token 预算（仅 input+output，v4 条件 6）；0 = 不限。 */
  budgetTokens: number;
  /** 累计成本预算（美元，cost.total 主口径；verifier 成本计入）；0 = 不限。 */
  budgetCostUsd: number;
  /** 评估器 agent 类型（D2：不新建类型，复用现成 verifier + 三重覆盖）。 */
  verifierType: string;
  /** 评估器模型 hint（D1：判定模型 ≠ 干活模型，默认 sonnet-5 覆盖主会话跑 k3 系的常见情况）。 */
  verifierModelHint: string;
  /** 单次评估超时（v4 条件 10：闩锁看门狗强制解锁并计入连败）。Default 300s。 */
  evalTimeoutMs: number;
  /** until-cmd 执行超时（C2）。Default 300s。 */
  untilCmdTimeoutMs: number;
  /** 续跑投递看门狗（v4 条件 4：未观察到新 run 则重试一次，再失败 → stopped）。Default 30s。 */
  deliveryWatchdogMs: number;
}

/**
 * Deferred /reload (src/reload/): intercept exact `/reload` submissions while
 * subagents are still running and fire the real reload once the fleet settles.
 * Field-by-field tolerant parsing (parseReloadSettings), never throws.
 */
export interface ReloadSettings {
  /** Gate for the editor interception only; `/agent reload` works regardless. Default true. */
  defer: boolean;
}

/**
 * system prompt 稳定化（docs/dev/sysprompt-stable/plan.md v3.1 §3.2/§3.5）。S1 阶段
 * 只有 `wakeReplay` 一个键（U5）：通知唤醒轮（`triggerTurn: true` 的 sendMessage）
 * 不经过 `before_agent_start`，开头与用户轮不同 ⇒ 整前缀缓存来回失效；开启时把
 * 用户轮捕获的强制文本按 pi 强制投影的形态回放到唤醒请求。`false` = 整层不注册
 * （不是注册后空转），行为与今天逐字节相同。`mode` / `adoptForeignForcedPrompt`
 * 随 M2 加入。逐字段容错解析见 parseSystemPromptSettings（never throws）。
 */
export interface SystemPromptSettings {
  /** Replay the last user run's forced system-prompt bytes onto notification wake runs. Default true. */
  wakeReplay: boolean;
  /** stable freezes sections; live refreshes through the hub; legacy keeps raw live semantics. */
  mode: "stable" | "live" | "legacy";
  /** Permit adopting text appended by a later extension to our forced prompt. */
  adoptForeignForcedPrompt: boolean;
}

export interface AgentSettings {
  concurrencyLimit: number;
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
  worktree: { enabled: boolean; gitTimeoutMs: number };
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
  /** /goal 目标驱动持续运行（goal-plan v4）。 */
  goal: GoalSettings;
  /** consult：轮内同步请教（consult plan §4.6）。 */
  consult: ConsultSettings;
  /** Merged plugins (plugin-merge): HUD footer takeover. Default on; `enabled:false` leaves pi's built-in footer untouched. */
  hud: HudSettings;
  /** Merged plugins: web_search tool (Codex/SerpAPI/Bocha/Tavily failover). Default on. */
  webSearch: EnabledGroup;
  /** Merged plugins: TaskCreate/List/Get/Update/Delete + /tasklist + aboveEditor widget. Default on. */
  todo: EnabledGroup;
  /** ask_user interactive question tool (main session only — child subagent sessions never see it). Default on. */
  askUser: EnabledGroup;
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
}

/** Simple on/off settings group shared by the merged plugins (webSearch / todo). */
export interface EnabledGroup {
  enabled: boolean;
}

/**
 * HUD settings group. `autoFetchMinutes`: HUD 周期 `git fetch --quiet --prune`
 * 的间隔（分钟）——↑/↓ 计数对比的是本地 remote-tracking ref，不 fetch 就永远
 * 看不到别处推进的远程提交；0 = 关闭（只保留手动 /pi-hud-refresh）。
 */
export interface HudSettings extends EnabledGroup {
  autoFetchMinutes: number;
}

export interface FabricSettings {
  enabled: boolean;
  minIntervalMs: number;
  maxPerRun: number;
  findingQuota: number;
  directiveQuota: number;
  deadLetterQuota: number;
  maxChars: number;
  progressTtlMs: number;
  progressChannel: "context" | "display";
  rootMinIntervalMs: number;
  rootInboxCap: number;
}
/** 动态阈值默认值（§11.2）：mode 默认 on（用户拍板 D1）；maxQualityPercent/rediscoveryUsd 均未校准。 */
export const DEFAULT_DYNAMIC_THRESHOLD_SETTINGS: DynamicThresholdSettings = {
  mode: "on",
  minHintPercent: 35,
  maxQualityPercent: 60,
  rediscoveryUsd: 10,
  unknownPriceMode: "static",
};

export const DEFAULT_SETTINGS: AgentSettings = {
  concurrencyLimit: 6,
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
  worktree: { enabled: false, gitTimeoutMs: 30_000 },
  maxNestedDepth: 3,
  fleetWidget: true,
  fleetTerminalLingerMs: 5_000,
  fleetAwaitNotificationMs: 600_000,
  fleetDeadlineWarnMs: 60_000,
  resultMaxChars: 32_000,
  workflow: {
    enabled: false,
    budget: {},
    replayTtlMs: 7 * 24 * 60 * 60 * 1_000,
    replayScope: "chain",
    runawayPolicy: "diagnose_only",
  },
  bashJobs: {
    autoBackgroundMs: 290_000,
    maxLogBytes: 10_485_760,
    maxBackgroundJobs: 8,
    retentionMs: 24 * 60 * 60 * 1_000,
    drainTimeoutMs: 30_000,
    shutdownPolicy: "keep",
  },
  compact: {
    enabled: true,
    hintThresholdPercent: DEFAULT_HINT_THRESHOLD_PERCENT,
    forceAtPercent: DEFAULT_FORCE_THRESHOLD_PERCENT,
    forceScaling: true,
    hintThresholdTokens: 500,
    forceAtTokens: 0,
    usageTickStepPercent: DEFAULT_USAGE_TICK_STEP_PERCENT,
    switchTool: true,
    keepCompactTool: false,
    forceDemandTurns: 1,
    dynamicThreshold: DEFAULT_DYNAMIC_THRESHOLD_SETTINGS,
  },
  fabric: {
    enabled: false,
    minIntervalMs: 30_000,
    maxPerRun: 20,
    findingQuota: 10,
    directiveQuota: 5,
    deadLetterQuota: 5,
    maxChars: 2_000,
    progressTtlMs: 900_000,
    progressChannel: "display",
    rootMinIntervalMs: 10_000,
    rootInboxCap: 12,
  },
  cacheTtl: {
    mode: "auto",
    keepalive: true,
    keepaliveIntervalMs: 240_000,
    keepaliveMaxPings: 11,
    keepaliveMinPrefixTokens: 20_000,
    keepaliveUpgradeAfterBudget: true,
    adaptiveEnabled: true,
    adaptiveWriteBudgetTokens: 200_000,
    adaptiveWriteBudgetUsd: 1.0,
    adaptiveFeeBudgetTokens: 600_000,
    adaptiveFeeBudgetUsd: 3.0,
    adaptiveMaxDeltaTokens: 32_000,
    adaptiveRefreshAfterTokens: 16_000,
    adaptiveColdUpgrades: 1,
    adaptiveColdCooldownMs: 1_200_000,
    adaptiveColdMinHorizonMs: 600_000,
    adaptiveHistoryGapSignal: true,
  },
  quota: {
    enabled: true,
    providers: "zai-coding-cn,zai,kimi-coding",
    subscriptionProviders: "",
    refreshMs: 600_000, // 10min（简报的 refreshMinutes: 10）
    refreshHotMs: 120_000, // 2min（L1/近耗尽 provider）
    staleAfterMs: 3_600_000, // 1h
    l1Percent: 50,
    l2Percent: 75,
    l3Percent: 90,
    l3EtaMs: 1_800_000, // 30min（简报的 ETA < 30min）
    tickStepPercent: 10,
    minIntervalMs: 300_000, // 5min
    repeatMs: 1_800_000, // 30min
    display: true,
    gate: true,
    gateLevel: 3,
    hud: true,
    requestTimeoutMs: 10_000,
    zaiBaseUrl: "https://open.bigmodel.cn",
    zaiOverseasBaseUrl: "https://api.z.ai",
    kimiBaseUrl: "https://api.kimi.com",
    userAgent: "",
  },
  extend: { enabled: true, notify: "background" },
  goal: {
    enabled: true,
    maxTurns: 20,
    maxMinutes: 120,
    budgetTokens: 0,
    budgetCostUsd: 0,
    verifierType: "verifier",
    verifierModelHint: "cloudrouter-anthropic/claude-sonnet-5",
    evalTimeoutMs: 300_000,
    untilCmdTimeoutMs: 300_000,
    deliveryWatchdogMs: 30_000,
  },
  consult: {
    enabled: true,
    timeoutMs: 150_000,
    maxAnswerChars: 2_000,
    maxTurns: 3,
    maxFirstRequestUsd: 2,
    maxCostUsd: 4,
    maxConcurrent: 2,
  },
  hud: { enabled: true, autoFetchMinutes: 5 },
  webSearch: { enabled: true },
  todo: { enabled: true },
  askUser: { enabled: true },
  feishuNotify: { enabled: true },
  sessionNav: { enabled: true },
  memory: {
    enabled: true,
    injectInChildSessions: true,
    allowWriteInChildSessions: false,
    freezeInjectionAfterWrite: false,
    inlineMax: 3,
    byteCap: 4000,
    indexMax: 15,
    maxFileBytes: 262_144,
    maxWriteBytes: 65_536,
  },
  reload: { defer: true },
  systemPrompt: { wakeReplay: true, mode: "stable", adoptForeignForcedPrompt: false },
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
  "fabric.minIntervalMs",
  "fabric.progressTtlMs",
  "fabric.rootMinIntervalMs",
  "goal.evalTimeoutMs",
  "goal.untilCmdTimeoutMs",
  "goal.deliveryWatchdogMs",
  "consult.timeoutMs",
  "cacheTtl.keepaliveIntervalMs",
  "cacheTtl.adaptiveColdCooldownMs",
  "cacheTtl.adaptiveColdMinHorizonMs",
  "quota.refreshMs",
  "quota.refreshHotMs",
  "quota.staleAfterMs",
  "quota.l3EtaMs",
  "quota.minIntervalMs",
  "quota.repeatMs",
  "quota.requestTimeoutMs",
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
  if (source === null || typeof source !== "object") return { ...DEFAULT_SETTINGS, budget: { ...DEFAULT_BUDGET } };
  const value = normalizeTimeUnits(source as Record<string, unknown>, TIME_SETTING_MS_PATHS);
  const budget =
    value.budget && typeof value.budget === "object" ? (value.budget as Partial<DeadlineBudget>) : undefined;
  return mergeSettings({
    concurrencyLimit:
      typeof value.concurrencyLimit === "number" && value.concurrencyLimit >= 0
        ? value.concurrencyLimit
        : DEFAULT_SETTINGS.concurrencyLimit,
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
          }
        : { ...DEFAULT_SETTINGS.worktree },
    workflow: parseWorkflowSettings(value.workflow),
    bashJobs: parseBashJobsSettings(value.bashJobs),
    compact: parseCompactSettings(value.compact),
    fabric: parseFabricSettings(value.fabric),
    cacheTtl: parseCacheTtlSettings(value.cacheTtl),
    quota: parseQuotaSettings(value.quota),
    extend: parseExtendSettings(value.extend),
    goal: parseGoalSettings(value.goal),
    consult: parseConsultSettings(value.consult),
    hud: parseHudSettings(value.hud),
    webSearch: parseEnabledGroup(value.webSearch, DEFAULT_SETTINGS.webSearch),
    todo: parseEnabledGroup(value.todo, DEFAULT_SETTINGS.todo),
    askUser: parseEnabledGroup(value.askUser, DEFAULT_SETTINGS.askUser),
    feishuNotify: parseEnabledGroup(value.feishuNotify, DEFAULT_SETTINGS.feishuNotify),
    sessionNav: parseEnabledGroup(value.sessionNav, DEFAULT_SETTINGS.sessionNav),
    memory: parseMemorySettings(value.memory),
    reload: parseReloadSettings(value.reload),
    systemPrompt: parseSystemPromptSettings(value.systemPrompt),
  });
}

/**
 * consult settings 块解析（plan §4.6）：逐字段容错、never throws（parseGoalSettings
 * 同款风格）。数字须 finite 且 ≥ 0；计数/时长字段要求整数；美元阈值允许小数
 * （exactOptionalPropertyTypes：七个字段总是存在，不设可选键）。
 */
export function parseConsultSettings(input: unknown): ConsultSettings {
  const defaults = DEFAULT_SETTINGS.consult;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const num = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  const int = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && Number.isInteger(raw) && raw >= 0 ? raw : fallback;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    // totalMs 硬顶：0 会让 applyBudgetPolicy 退回默认预算（无硬顶），所以下界是 1ms 而不是 0。
    timeoutMs: (() => {
      const parsed = int(value.timeoutMs, defaults.timeoutMs);
      return parsed > 0 ? parsed : defaults.timeoutMs;
    })(),
    maxAnswerChars: (() => {
      const parsed = int(value.maxAnswerChars, defaults.maxAnswerChars);
      return parsed > 0 ? parsed : defaults.maxAnswerChars;
    })(),
    maxTurns: (() => {
      const parsed = int(value.maxTurns, defaults.maxTurns);
      return parsed > 0 ? parsed : defaults.maxTurns;
    })(),
    // 两个美元阈值允许 0（= 关闭对应闸门），故走 num 而不是「> 0 才收」。
    maxFirstRequestUsd: num(value.maxFirstRequestUsd, defaults.maxFirstRequestUsd),
    maxCostUsd: num(value.maxCostUsd, defaults.maxCostUsd),
    maxConcurrent: (() => {
      const parsed = int(value.maxConcurrent, defaults.maxConcurrent);
      return parsed > 0 ? parsed : defaults.maxConcurrent;
    })(),
  };
}

/**
 * /goal settings 块解析：逐字段容错、never throws（parseBashJobsSettings 同款
 * 风格）。数字须 finite 且 ≥ 0；verifierType/verifierModelHint 为空串回落默认
 * （exactOptionalPropertyTypes：字段总是存在，不设可选键）。
 */
export function parseGoalSettings(input: unknown): GoalSettings {
  const defaults = DEFAULT_SETTINGS.goal;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const num = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  const int = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && Number.isInteger(raw) && raw >= 0 ? raw : fallback;
  const str = (raw: unknown, fallback: string): string => (typeof raw === "string" && raw.length > 0 ? raw : fallback);
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    maxTurns: int(value.maxTurns, defaults.maxTurns),
    maxMinutes: int(value.maxMinutes, defaults.maxMinutes),
    budgetTokens: int(value.budgetTokens, defaults.budgetTokens),
    budgetCostUsd: num(value.budgetCostUsd, defaults.budgetCostUsd),
    verifierType: str(value.verifierType, defaults.verifierType),
    verifierModelHint: str(value.verifierModelHint, defaults.verifierModelHint),
    evalTimeoutMs: num(value.evalTimeoutMs, defaults.evalTimeoutMs),
    untilCmdTimeoutMs: num(value.untilCmdTimeoutMs, defaults.untilCmdTimeoutMs),
    deliveryWatchdogMs: num(value.deliveryWatchdogMs, defaults.deliveryWatchdogMs),
  };
}

function parseFabricSettings(input: unknown): FabricSettings {
  const defaults = DEFAULT_SETTINGS.fabric;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const count = (key: keyof FabricSettings): number => {
    const raw = value[key];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : (defaults[key] as number);
  };
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    minIntervalMs: count("minIntervalMs"),
    maxPerRun: count("maxPerRun"),
    findingQuota: count("findingQuota"),
    directiveQuota: count("directiveQuota"),
    deadLetterQuota: count("deadLetterQuota"),
    maxChars: count("maxChars"),
    progressTtlMs: count("progressTtlMs"),
    progressChannel:
      value.progressChannel === "context" || value.progressChannel === "display"
        ? value.progressChannel
        : defaults.progressChannel,
    rootMinIntervalMs: count("rootMinIntervalMs") === 0 ? 0 : Math.max(1_000, count("rootMinIntervalMs")),
    rootInboxCap: count("rootInboxCap"),
  };
}

/** Parse the optional Anthropic prompt-cache TTL settings block. Field-by-field tolerant (parseMemorySettings 同款 bool()/num() helpers), never throws. */
export function parseCacheTtlSettings(input: unknown): CacheTtlSettings {
  const defaults = DEFAULT_SETTINGS.cacheTtl;
  // 缺省整块时也走 adaptiveEnabled 升格（§7.1）：开 ⇒ "adaptive"，关 ⇒ 现状 "auto"。
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ...defaults, mode: defaults.adaptiveEnabled ? "adaptive" : defaults.mode };
  const value = input as Record<string, unknown>;
  const bool = (raw: unknown, fallback: boolean): boolean => (typeof raw === "boolean" ? raw : fallback);
  const num = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? Math.floor(raw) : fallback;
  // USD 变体：不取整——0.5 的预算被 floor 成 0 会把「半美元」误读成「关闭」，方向不可接受。
  const usd = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
  const mode = value.mode;
  const adaptiveEnabled = bool(value.adaptiveEnabled, defaults.adaptiveEnabled);
  return {
    // adaptive 方案 §7.1（默认值修订）：显式写的合法 mode 一律尊重；缺省/非法时
    // 由 adaptiveEnabled 单开关决定默认档（开 ⇒ "adaptive"，关 ⇒ "auto"——与现状逐字节一致）。
    mode:
      mode === "auto" || mode === "on" || mode === "off" || mode === "adaptive"
        ? mode
        : adaptiveEnabled
          ? "adaptive"
          : defaults.mode,
    keepalive: bool(value.keepalive, defaults.keepalive),
    keepaliveIntervalMs: num(value.keepaliveIntervalMs, defaults.keepaliveIntervalMs, 60_000, 280_000),
    keepaliveMaxPings: num(value.keepaliveMaxPings, defaults.keepaliveMaxPings, 0, Number.MAX_SAFE_INTEGER),
    keepaliveMinPrefixTokens: num(
      value.keepaliveMinPrefixTokens,
      defaults.keepaliveMinPrefixTokens,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    keepaliveUpgradeAfterBudget: bool(value.keepaliveUpgradeAfterBudget, defaults.keepaliveUpgradeAfterBudget),
    adaptiveEnabled,
    adaptiveWriteBudgetTokens: num(
      value.adaptiveWriteBudgetTokens,
      defaults.adaptiveWriteBudgetTokens,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    adaptiveWriteBudgetUsd: usd(value.adaptiveWriteBudgetUsd, defaults.adaptiveWriteBudgetUsd, 0, 100),
    adaptiveFeeBudgetTokens: num(
      value.adaptiveFeeBudgetTokens,
      defaults.adaptiveFeeBudgetTokens,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    adaptiveFeeBudgetUsd: usd(value.adaptiveFeeBudgetUsd, defaults.adaptiveFeeBudgetUsd, 0, 100),
    adaptiveMaxDeltaTokens: num(
      value.adaptiveMaxDeltaTokens,
      defaults.adaptiveMaxDeltaTokens,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    adaptiveRefreshAfterTokens: num(
      value.adaptiveRefreshAfterTokens,
      defaults.adaptiveRefreshAfterTokens,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    adaptiveColdUpgrades: num(value.adaptiveColdUpgrades, defaults.adaptiveColdUpgrades, 0, Number.MAX_SAFE_INTEGER),
    adaptiveColdCooldownMs: num(value.adaptiveColdCooldownMs, defaults.adaptiveColdCooldownMs, 60_000, 7_200_000),
    adaptiveColdMinHorizonMs: num(value.adaptiveColdMinHorizonMs, defaults.adaptiveColdMinHorizonMs, 0, 7_200_000),
    adaptiveHistoryGapSignal: bool(value.adaptiveHistoryGapSignal, defaults.adaptiveHistoryGapSignal),
  };
}
/**
 * Parse the optional `quota` settings block (quota-plan §8.3). Field-by-field
 * tolerant (parseCacheTtlSettings 同款 bool()/num() 手法), never throws.
 * Threshold monotonicity is clamped (l1 <= l2 <= l3 — a config written backwards
 * is pushed up, not silently ignored); `providers` keeps empty strings (empty
 * = all providers off); base URLs must be http(s) and lose trailing slashes.
 */
export function parseQuotaSettings(input: unknown): QuotaSettings {
  const defaults = DEFAULT_SETTINGS.quota;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const bool = (raw: unknown, fallback: boolean): boolean => (typeof raw === "boolean" ? raw : fallback);
  const num = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? Math.floor(raw) : fallback;
  // 注意：providers 允许空串（空串 = 全部关闭），userAgent 同理（空串 = 内置默认）。
  const str = (raw: unknown, fallback: string): string => (typeof raw === "string" ? raw : fallback);
  const url = (raw: unknown, fallback: string): string => {
    const v = typeof raw === "string" ? raw.trim() : "";
    return /^https?:\/\//i.test(v) ? v.replace(/\/+$/, "") : fallback; // 非 http(s) 一律回落默认
  };
  // 阈值单调性钳制：l1 <= l2 <= l3，越界者被后者顶上去（配置写反不会静默失效）。
  const l1 = num(value.l1Percent, defaults.l1Percent, 1, 100);
  const l2 = Math.max(l1, num(value.l2Percent, defaults.l2Percent, 1, 100));
  const l3 = Math.max(l2, num(value.l3Percent, defaults.l3Percent, 1, 100));
  return {
    enabled: bool(value.enabled, defaults.enabled),
    providers: str(value.providers, defaults.providers),
    subscriptionProviders: str(value.subscriptionProviders, defaults.subscriptionProviders),
    refreshMs: num(value.refreshMs, defaults.refreshMs, 60_000, 86_400_000),
    refreshHotMs: num(value.refreshHotMs, defaults.refreshHotMs, 1, 86_400_000),
    staleAfterMs: num(value.staleAfterMs, defaults.staleAfterMs, 60_000, 604_800_000),
    l1Percent: l1,
    l2Percent: l2,
    l3Percent: l3,
    l3EtaMs: num(value.l3EtaMs, defaults.l3EtaMs, 0, 86_400_000),
    tickStepPercent: num(value.tickStepPercent, defaults.tickStepPercent, 0, 50),
    minIntervalMs: num(value.minIntervalMs, defaults.minIntervalMs, 0, 86_400_000),
    repeatMs: num(value.repeatMs, defaults.repeatMs, 0, 86_400_000),
    display: bool(value.display, defaults.display),
    gate: bool(value.gate, defaults.gate),
    gateLevel: num(value.gateLevel, defaults.gateLevel, 1, 3),
    hud: bool(value.hud, defaults.hud),
    requestTimeoutMs: num(value.requestTimeoutMs, defaults.requestTimeoutMs, 1_000, 60_000),
    zaiBaseUrl: url(value.zaiBaseUrl, defaults.zaiBaseUrl),
    zaiOverseasBaseUrl: url(value.zaiOverseasBaseUrl, defaults.zaiOverseasBaseUrl),
    kimiBaseUrl: url(value.kimiBaseUrl, defaults.kimiBaseUrl),
    userAgent: str(value.userAgent, defaults.userAgent),
  };
}

/** Parse an `{enabled}` on/off group (merged plugins); field-level fallback to defaults, never throws. */
function parseEnabledGroup(input: unknown, defaults: EnabledGroup): EnabledGroup {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const enabled = (input as Record<string, unknown>).enabled;
  return { enabled: typeof enabled === "boolean" ? enabled : defaults.enabled };
}

/** HUD 设置块解析：enabled 复用 EnabledGroup 语义，autoFetchMinutes 须 finite 且 ≥ 0；逐字段回落默认，never throws。 */
function parseHudSettings(input: unknown): HudSettings {
  const defaults = DEFAULT_SETTINGS.hud;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const record = input as Record<string, unknown>;
  const minutes = record.autoFetchMinutes;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    autoFetchMinutes:
      typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0 ? minutes : defaults.autoFetchMinutes,
  };
}

/**
 * Parse the optional `memory` settings block (memory-plan §3.2). Malformed or
 * missing input falls back field-by-field to DEFAULT_SETTINGS.memory; never
 * throws (parseBashJobsSettings 同款）。Numbers must be finite and inside
 * their documented range; `maxWriteBytes` is additionally clamped to
 * ≤ maxFileBytes so a single write can never exceed the per-file cap.
 */
export function parseMemorySettings(input: unknown): MemorySettings {
  const defaults = DEFAULT_SETTINGS.memory;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const bool = (raw: unknown, fallback: boolean): boolean => (typeof raw === "boolean" ? raw : fallback);
  const num = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? Math.floor(raw) : fallback;
  const maxFileBytes = num(value.maxFileBytes, defaults.maxFileBytes, 1024, 4 * 1024 * 1024);
  return {
    enabled: bool(value.enabled, defaults.enabled),
    injectInChildSessions: bool(value.injectInChildSessions, defaults.injectInChildSessions),
    allowWriteInChildSessions: bool(value.allowWriteInChildSessions, defaults.allowWriteInChildSessions),
    freezeInjectionAfterWrite: bool(value.freezeInjectionAfterWrite, defaults.freezeInjectionAfterWrite),
    inlineMax: num(value.inlineMax, defaults.inlineMax, 0, 50),
    byteCap: num(value.byteCap, defaults.byteCap, 0, 65_536),
    indexMax: num(value.indexMax, defaults.indexMax, 1, 100),
    maxFileBytes,
    maxWriteBytes: Math.min(num(value.maxWriteBytes, defaults.maxWriteBytes, 256, 4 * 1024 * 1024), maxFileBytes),
  };
}

/** Parse the optional deferred-reload settings block (parseCacheTtlSettings 同款容错, never throws). */
export function parseReloadSettings(input: unknown): ReloadSettings {
  const defaults = DEFAULT_SETTINGS.reload;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const defer = (input as Record<string, unknown>).defer;
  return { defer: typeof defer === "boolean" ? defer : defaults.defer };
}

/** Parse the optional `systemPrompt` settings block (sysprompt-stable §3.2). Field-by-field fallback to defaults, never throws. */
export function parseSystemPromptSettings(input: unknown): SystemPromptSettings {
  const defaults = DEFAULT_SETTINGS.systemPrompt;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const mode = value.mode;
  return {
    wakeReplay: typeof value.wakeReplay === "boolean" ? value.wakeReplay : defaults.wakeReplay,
    mode: mode === "stable" || mode === "live" || mode === "legacy" ? mode : defaults.mode,
    adoptForeignForcedPrompt:
      typeof value.adoptForeignForcedPrompt === "boolean"
        ? value.adoptForeignForcedPrompt
        : defaults.adoptForeignForcedPrompt,
  };
}

/** Parse the optional timeout grace/extension settings block（parseCacheTtlSettings 同款容错，never throws）。 */
export function parseExtendSettings(input: unknown): ExtendSettings {
  const defaults = DEFAULT_SETTINGS.extend;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    notify:
      value.notify === "background" || value.notify === "always" || value.notify === "off"
        ? value.notify
        : defaults.notify,
  };
}
/** 解析 compact.dynamicThreshold（§11.1）：逐字段回退默认、交叉校验 min>max ⇒ 两者回默认、枚举白名单，永不抛。 */
export function parseDynamicThresholdSettings(input: unknown): DynamicThresholdSettings {
  const defaults = DEFAULT_DYNAMIC_THRESHOLD_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const mode = value.mode;
  const unknownPriceMode = value.unknownPriceMode;
  const percent = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? Math.floor(raw) : fallback;
  const min = percent(value.minHintPercent, defaults.minHintPercent);
  const max = percent(value.maxQualityPercent, defaults.maxQualityPercent);
  const crossed = min > max; // 交叉校验：min > max ⇒ 两者都回默认（§11.1）
  const rediscovery = value.rediscoveryUsd;
  return {
    mode: mode === "off" || mode === "shadow" || mode === "on" ? mode : defaults.mode,
    minHintPercent: crossed ? defaults.minHintPercent : min,
    maxQualityPercent: crossed ? defaults.maxQualityPercent : max,
    rediscoveryUsd:
      typeof rediscovery === "number" && Number.isFinite(rediscovery) && rediscovery >= 0
        ? rediscovery
        : defaults.rediscoveryUsd,
    unknownPriceMode:
      unknownPriceMode === "static" || unknownPriceMode === "quality" ? unknownPriceMode : defaults.unknownPriceMode,
  };
}

/** Parse the optional model-triggered context compaction settings block. */
export function parseCompactSettings(input: unknown): CompactSettings {
  const defaults = DEFAULT_SETTINGS.compact;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const threshold = value.hintThresholdPercent;
  const hintThresholdPercent =
    typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 1 && threshold <= 100
      ? Math.floor(threshold)
      : threshold === 0
        ? 0
        : defaults.hintThresholdPercent;
  const force = value.forceAtPercent;
  const forceAtPercent =
    typeof force === "number" &&
    Number.isFinite(force) &&
    force >= 0 &&
    force <= 100 &&
    (force === 0 || Math.floor(force) > hintThresholdPercent)
      ? Math.floor(force)
      : defaults.forceAtPercent;
  const hintTokens = value.hintThresholdTokens;
  const hintThresholdTokens =
    typeof hintTokens === "number" && Number.isFinite(hintTokens) && hintTokens >= 0
      ? Math.floor(hintTokens)
      : defaults.hintThresholdTokens;
  const forceTokens = value.forceAtTokens;
  const forceAtTokens =
    typeof forceTokens === "number" &&
    Number.isFinite(forceTokens) &&
    forceTokens >= 0 &&
    (forceTokens === 0 || Math.floor(forceTokens) > hintThresholdTokens)
      ? Math.floor(forceTokens)
      : defaults.forceAtTokens;
  const reserve = value.assumedReserveTokens;
  const tick = value.usageTickStepPercent;
  const demandTurns = value.forceDemandTurns;
  return {
    switchTool: typeof value.switchTool === "boolean" ? value.switchTool : defaults.switchTool,
    keepCompactTool: typeof value.keepCompactTool === "boolean" ? value.keepCompactTool : defaults.keepCompactTool,
    forceDemandTurns:
      typeof demandTurns === "number" && Number.isFinite(demandTurns) && demandTurns >= 0 && demandTurns <= 5
        ? Math.floor(demandTurns)
        : defaults.forceDemandTurns,
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    hintThresholdPercent,
    forceAtPercent,
    forceScaling: typeof value.forceScaling === "boolean" ? value.forceScaling : defaults.forceScaling,
    hintThresholdTokens,
    forceAtTokens,
    usageTickStepPercent:
      typeof tick === "number" && Number.isFinite(tick) && (tick === 0 || (tick >= 5 && tick <= 100))
        ? Math.floor(tick)
        : defaults.usageTickStepPercent,
    dynamicThreshold: parseDynamicThresholdSettings(value.dynamicThreshold),
    ...(typeof reserve === "number" && Number.isFinite(reserve) && reserve > 0
      ? { assumedReserveTokens: Math.floor(reserve) }
      : {}),
  };
}

/**
 * §6: parse the optional `bashJobs` settings block. Malformed/missing input
 * falls back field-by-field to DEFAULT_SETTINGS.bashJobs; never throws.
 * Numbers must be finite and >= 0, `shutdownPolicy` is whitelisted, and the
 * optional string fields are dropped unless they are non-empty strings
 * (exactOptionalPropertyTypes: absent, not `undefined`).
 */
export function parseBashJobsSettings(input: unknown): BashJobsSettings {
  const defaults = DEFAULT_SETTINGS.bashJobs;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const num = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  const str = (raw: unknown): string | undefined => (typeof raw === "string" && raw.length > 0 ? raw : undefined);
  const dir = str(value.dir);
  const shellPath = str(value.shellPath);
  return {
    autoBackgroundMs: num(value.autoBackgroundMs, defaults.autoBackgroundMs),
    maxLogBytes: num(value.maxLogBytes, defaults.maxLogBytes),
    maxBackgroundJobs: num(value.maxBackgroundJobs, defaults.maxBackgroundJobs),
    retentionMs: num(value.retentionMs, defaults.retentionMs),
    drainTimeoutMs:
      typeof value.drainTimeoutMs === "number" &&
      Number.isFinite(value.drainTimeoutMs) &&
      value.drainTimeoutMs > 0 &&
      Number.isInteger(value.drainTimeoutMs)
        ? value.drainTimeoutMs
        : defaults.drainTimeoutMs,
    shutdownPolicy:
      value.shutdownPolicy === "keep" || value.shutdownPolicy === "kill"
        ? value.shutdownPolicy
        : defaults.shutdownPolicy,
    ...(dir === undefined ? {} : { dir }),
    ...(shellPath === undefined ? {} : { shellPath }),
  };
}

/** CC3: parse the optional `workflow` settings block; malformed/missing input falls back field-by-field to DEFAULT_SETTINGS.workflow (never throws, matches the rest of loadSettings' tolerance). */
function parseWorkflowSettings(input: unknown): WorkflowSettings {
  const defaults = DEFAULT_SETTINGS.workflow;
  if (!input || typeof input !== "object") return { ...defaults };
  const value = input as Record<string, unknown>;
  const budget = value.budget && typeof value.budget === "object" ? (value.budget as Partial<WorkflowBudget>) : {};
  const validBudgetKeys = Object.keys(DEFAULT_WORKFLOW_BUDGET) as (keyof WorkflowBudget)[];
  const cleanedBudget: Partial<WorkflowBudget> = {};
  for (const key of validBudgetKeys) {
    const v = budget[key];
    if (typeof v !== "number" || !(v >= 0)) continue;
    // workflow-agent-queue §0/Major-2 (same shape as the subagent D-11 rule):
    // workflowTotalMs must be > 0. BW10 ("0 = no workflow cap") never worked in
    // background mode — background.ts bounds its driver race by
    // workflowTotalMs + slack, so 0 ended every run after ~14s — and a queued
    // agent() call needs a finite ack.deadlineAt. Drop it here so the default
    // applies; loadSettingsFromFile WARNs once.
    if (key === "workflowTotalMs" && v <= 0) continue;
    cleanedBudget[key] = v;
  }
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    budget: cleanedBudget,
    ...(typeof value.journalDir === "string" ? { journalDir: value.journalDir } : {}),
    replayTtlMs:
      typeof value.replayTtlMs === "number" && value.replayTtlMs >= 0 ? value.replayTtlMs : defaults.replayTtlMs,
    replayScope:
      value.replayScope === "chain" || value.replayScope === "content" ? value.replayScope : defaults.replayScope,
    runawayPolicy:
      value.runawayPolicy === "diagnose_only" || value.runawayPolicy === "terminate_on_stall"
        ? value.runawayPolicy
        : defaults.runawayPolicy,
  };
}

/** Default user-level settings file: ~/.pi/agent/pi-subagent.json */
export function defaultSettingsPath(): string {
  return join(homedir(), ".pi", "agent", "pi-subagent.json");
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
    const parsed: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return loadSettings(parsed);
    const timed = migrateSettingsFileTimeUnits(parsed as Record<string, unknown>, path);
    const cache = migrateLegacyCacheTtlState(timed.value, path, join(dirname(path), "cache-ttl-state.json"));
    const changed = timed.changed || cache.changed;
    let writeSucceeded = true;
    if (changed) {
      try {
        // Atomic write (tmp + rename): this file is shared by every session in
        // the process tree, so a torn write would read back as malformed JSON
        // and silently reset all settings to defaults (review B1).
        const tmpPath = `${path}.${process.pid}.tmp`;
        writeFileSync(tmpPath, JSON.stringify(cache.value, null, 2) + "\n", "utf8");
        renameSync(tmpPath, path);
      } catch (error) {
        writeSucceeded = false;
        console.warn(
          `[pi-subagent] failed to write the migrated ${path}: ${error instanceof Error ? error.message : String(error)}; the migration will be retried next time.`,
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
 * (~/.pi/agent/pi-subagent.json) from every child. Malformed/missing file →
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
  return { value: { ...raw, cacheTtl: { mode } }, changed: true, deleteLegacy: true, legacyPath };
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
export function persistSettingOverride(
  dottedKey: string,
  value: unknown,
  path: string = defaultSettingsPath(),
): string | undefined {
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
    writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf8");
    return undefined;
  } catch (error) {
    return `${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
