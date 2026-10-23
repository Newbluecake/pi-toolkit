import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_BUDGET } from "../core/deadline.js";
import type { AgentTypeConfig, DeadlineBudget, ExternalPriceRates, Millis } from "../core/types.js";
import { XS_DEFAULT_CHANNEL, XS_MAX_CHANNELS, checkChannelName, channelSet } from "../fabric/xs/channel.js";
import { dedupeLinkPaths } from "../extensions/worktree-link-paths.js";
import type { WorktreeSettings } from "../extensions/worktree-settings.js";
import { MAX_SAFE_KEEPALIVE_INTERVAL_MS } from "../cache-ttl/keepalive-state.js";
import { migrateTimeUnitsToSeconds, normalizeTimeUnits, secondsKeyOf } from "./time-units.js";
import { parseStrictModelRef } from "./model-hint.js";
import { getSecureDomain, statePathsOf } from "../secure/domain.js";
import { withSettingsFileLock, writeSettingsFileAtomic } from "../secure/settings-lock.js";
import {
  DEFAULT_FORCE_THRESHOLD_PERCENT,
  DEFAULT_HINT_THRESHOLD_PERCENT,
  DEFAULT_USAGE_TICK_STEP_PERCENT,
} from "../compact-hint/threshold.js";
import {
  DEFAULT_TIDY_BATCH_SETTINGS,
  resolveTidyBatchSettings,
  type TidyBatchSettings,
} from "../memory/tidy/batch-settings.js";
// web-hub (plan 包 I): the settings type is owned by package D; `import type`
// only, so this pre-guard module never loads the web-hub runtime graph.
import type {
  WebHubLanSettings,
  WebHubSettings as AgentWebHubSettings,
  WebHubSpawnSettings,
} from "../web-hub/agent/index.js";
import type { WebHubLanSettingsWarnings } from "../commands/webhub.js";

/**
 * web-hub-proxy plan v2 §5 (X0): `webHub.proxy` — at most three leaves, non-live (captured at
 * activate; change → `/reload` then `/webhub restart`). Off by default; LAN reach follows
 * `webHub.lan` (Q2), there is no proxy LAN switch. `portRange` is stored as the canonical
 * `"<lo>-<hi>"` text (`protocol/proxy.ts` grammar); TTLs are fixed constants there, not settings.
 */
export interface WebHubProxySettings {
  enabled: boolean;
  portRange: string;
  maxProxies: number;
}
/**
 * feishu-bot plan v2 §9 (F0): the TOP-LEVEL `feishuBot` block (not under `webHub`) — non-live, captured
 * at activate (change → `/reload` then `/webhub restart`). Off by default ⇒ `buildHubConfig` never writes
 * `HubConfig.feishuBot` and the hub/agent stay byte-identical. The block only takes effect when
 * `webHub.enabled` ∧ `webHub.control !== false` too (FA's gate). `staleMessageS` is stored in SECONDS
 * (file key = internal key; deliberately NOT a `TIME_SETTING_MS_PATHS` entry), `debounceMs` in ms —
 * the plan's names verbatim. Keepalive is not a leaf (Q1 fixed it).
 */
export interface FeishuBotSettings {
  securityAlerts?: boolean;
  /** Mirror non-waking cross-session messages to bound p2p chats (default on; hub-start frozen). */
  xsMirror?: boolean;
  enabled: boolean;
  allowGroups: boolean;
  /** V8-confirmed: a group @-bot outside a topic opens + binds a topic */
  groupRootTopics: boolean;
  notify: "bound" | "off";
  spawnScope: "known" | "roots";
  debounceMs: number;
  staleMessageS: number;
  files: {
    outbound: "auto" | "buttons" | "off";
    inbound: boolean;
    maxInboundMiB: number;
  };
}
/** The agent-side `WebHubSettings` (owned by `web-hub/agent/index.ts`; `proxy?` is folded in there, X1c). */
export type WebHubSettings = AgentWebHubSettings;
export type { WebHubLanSettings, WebHubSpawnSettings };
// web-hub LAN (S1-W3 LI, lan-plan.md §9.1): host-token / origin classification is W1-frozen and
// shared by every layer that needs to agree on what counts as a valid host — settings validation
// (here, L16 第一处) is one of those layers, alongside `hub/main.ts`'s `parseHubLanConfig` (L16
// 第二处) and the request pipeline. Pure functions only, no pi import, no side effects.
import { canonicalOrigin, classifyHostToken, parseOrigin, type InvalidHostToken } from "../web-hub/protocol/lan.js";
import { parseClientCidr, CLIENT_ALLOW_MAX, type InvalidClientCidr } from "../web-hub/protocol/client-allow.js";
// quota (阶梯阈值按窗口区分): WindowScope is a zero-pi-import type from src/quota/types.ts
// (plan 分层纪律) —— type-only import, no runtime dependency on the quota module graph.
import type { QuotaPoolId, WindowScope } from "../quota/types.js";
// topic-switch plan.md P1 "settings.ts": config/settings.ts imports ONLY this module for the
// `topicSwitch` block — it owns the interface, the frozen defaults and the never-throws parser.
import {
  DEFAULT_TOPIC_SWITCH_SETTINGS,
  parseTopicSwitchSettings,
  type TopicSwitchSettings,
} from "../topic-switch/settings.js";
export type { TopicSwitchSettings };
// sysload plan (docs/dev/sysload/plan.md) §4/§6.1: `LoadSettings` itself lives here (same
// precedent as `QuotaSettings`/`CacheTtlSettings` — not every feature settings type moves out to
// its own module), but the pi-free domain shapes/defaults it is built from are frozen in
// `src/sysload/types.ts` (P0) and imported type/value as needed.
import {
  DEFAULT_LOAD_THRESHOLDS,
  DEFAULT_LOAD_RECOVER_MS,
  DEFAULT_LOAD_SAMPLE_INTERVAL_MS,
  DEFAULT_LOAD_SUSTAIN_MS,
  LOAD_SAMPLE_INTERVAL_MAX_MS,
  LOAD_SAMPLE_INTERVAL_MIN_MS,
  LOAD_SUSTAIN_RECOVER_MAX_FACTOR,
  type LoadCpuThresholds,
  type LoadDiskThresholds,
  type LoadMemThresholds,
} from "../sysload/types.js";

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
  // ─────────────────────── todo #22 optimize-plan §9 (P0-b) ───────────────────────
  /** tiered vs. legacy injection renderer. P5 defaults to `"tiered"`; explicit
   * `"legacy"` remains the byte-compatible opt-out. */
  layout: MemoryLayout;
  /** v2 vs. legacy `memory` tool factory. P5 defaults to `"v2"`; explicit
   * `"legacy"` remains the byte-compatible opt-out. */
  toolSurface: MemoryToolSurface;
  /** Child-session injection tier (§2.4) — only takes effect under
   *  `layout:"tiered"`; `layout:"legacy"` only honors `"none"` (everything
   *  else still injects the old block, §2.7's "legacy = old behavior"). */
  childProfile: ChildProfile;
  /** Primary-core byte budget within a tiered block. Default 1600; clamped to
   *  ≤ `blockBytes - 600` at parse time. */
  coreBytes: number;
  /** Hard byte cap for the whole tiered `## Memory` block. Default 2400. */
  blockBytes: number;
  /** Non-core file size that triggers a doctor warn (D04). Default 8192. */
  topicWarnBytes: number;
  /** Non-core file size that a write/append is rejected past (D05). Default
   *  16384; ≥ `topicWarnBytes`. */
  topicMaxBytes: number;
  doctor: MemoryDoctorSettings;
  tidy: MemoryTidySettings;
}

export type MemoryLayout = "tiered" | "legacy";
export type MemoryToolSurface = "v2" | "legacy";
export type ChildProfile = "core" | "full" | "none";

export interface MemoryDoctorSettings {
  /** Main-session, UI-only, once-per-session(+fingerprint) `/mem doctor`-style
   *  startup reminder when an error-level finding (or D01, no core.md) exists.
   *  Default true. */
  notifyOnStart: boolean;
  /** `updated` age (days) past which a file is flagged stale (D08 warn).
   *  Default 60. */
  staleDays: number;
}

export interface MemoryTidySettings {
  /** Agent type used for the tidy proposal-drafting subagent's system prompt
   *  / model hint ONLY — the runtime forces `toolDomain:"readonly"` (§7.0)
   *  regardless of this type's own `tools` list, so it can never widen what
   *  the proposal run can do. Default "Plan". */
  agentType: string;
  /** Strict `provider/id`, or "" to use the current main-session model at
   *  dispatch time (§7.1). Default "". */
  model: string;
  /** Hard total budget for a tidy run (no grace, no extension). File stores
   *  `tidy.timeoutS`. Default 180_000 (180s). */
  timeoutMs: number;
  /** Total input bytes a tidy/restore snapshot may cover before `/mem tidy`
   *  asks the user to narrow the file set. Default 49_152. */
  maxInputBytes: number;
  /** Hard cap on the tidy proposal's total output bytes (§7.2); over this,
   *  the WHOLE proposal is discarded, zero writes. Default 65_536. */
  maxOutputBytes: number;
  /** Cumulative cost cap (USD) for a tidy run; only enforced for a priced
   *  model (§7.1's N1: an unpriced model runs with a "no cost guarantee"
   *  warning instead of this gate). Default 2.0; never 0. */
  maxCostUsd: number;
  /** Turn-boundary cap; a tidy run is aborted (zero writes) once it would
   *  start turn `maxTurns + 1`. Default 4. */
  maxTurns: number;
  /** Batch tidy controls (§11); parsed by the frozen pi-free batch settings resolver. */
  batch: TidyBatchSettings;
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
  /**
   * replay-verify plan D9 (用户确认 1): whether a replayed `isolation:
   * "worktree"` call's journaled branch is checked against a load-time
   * snapshot before being reused. `"verify"` (default): only a `committed`
   * entry whose `pi-agent-<runId>` branch still exists and points EXACTLY at
   * the recorded commit at run start may be replayed; `clean` entries are
   * never checked (D3.1: same non-checking semantics as an ordinary call).
   * `"off"` restores the pre-plan behavior byte-for-byte (an isolated call
   * is unconditionally live, never journaled) — see the plan's D9 for the
   * exact scope of that guarantee.
   */
  isolationReplay: "verify" | "off";
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
  /** Shell used to run job commands. 2026-10-17 revision: when unset, the resolution mirrors pi's built-in bash tool — pi's own `shellPath` setting (`~`-expanded, project over global) → pi's default chain (/bin/bash → bash on PATH → sh); `$SHELL` is never consulted. Allow-listed basenames (bash/zsh/sh) apply to both explicit paths. */
  shellPath?: string;
  /** bash-timeout-grace §5.1 (U1): subagent/child sessions get the bash override + `bash_job` tool registered. Default true; `false` = child sessions stay on today's behavior (no auto-background, no bash_job, no settle hold). */
  childSessions: boolean;
  /** bash-timeout-grace §5.1 (U2): a settling child run with non-terminal background jobs is kept alive and reminded instead of finishing immediately. Default true; `false` = no settle hold (child.ts's `agent_before_settle` handler is never registered). */
  childSettleHold: boolean;
  /** bash-timeout-grace §3.5/§5.1 (C3): hard cap on settle-hold continuation rounds for one run. `0` (default) = auto, derived per run as `2 × R_wait` from the run's own hard deadline/extension budget (§3.5) — there is no "unlimited" value, set a large number instead. Non-integer/negative → 0 (auto). */
  childSettleHoldMaxRounds: number;
  /** bash-timeout-grace §5.1 (U4): grace window after a job-level `timeout` fires before an already-backgrounded job is killed, so `bash_job(action:"extend")` has a chance to run. Default 60_000 (60s); missing/negative/NaN → default; `0` = grace off (still-foreground jobs are always killed immediately regardless of this setting, §2.3). */
  timeoutGraceMs: number;
  /** bash-timeout-grace §5.1 (U4): max number of `bash_job(action:"extend")` calls accepted per job. Default 3; non-integer/negative → 3; `0` = extend disabled, which (D-6) also disables grace for that job. */
  maxExtensions: number;
  /** bash-timeout-grace §5.1 (U4): hard lifetime ceiling as a multiple of the job's original `timeout` (`hardAt = spawnedAt + ceil(timeoutMs × maxTimeoutFactor)`). Default 3; not finite or `< 1` → 3; `1` = zero headroom ⇒ no extend, no grace. */
  maxTimeoutFactor: number;
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
  /**
   * child-context-switch plan §4（用户确认 1）：子会话是否注册 switch_context 工具 +
   * turn_end/context/session_compact handler（另受 `compact.enabled && compact.switchTool` 与
   * §3.1 能力检测约束）。Default true。
   */
  childSessions: boolean;
  /**
   * child-context-switch plan §2.1/§4（评审 6）：每 run 切换上限，按分支上带
   * `details.source === "pi-toolkit:switch_context"` 的 fromHook compaction 条数计（resume 续写
   * 同一会话文件时计数延续）。Default 5；钳到 [1, 20]。
   */
  childMaxSwitches: number;
}

export type CacheTtlMode = "auto" | "on" | "off";
export interface CacheTtlSettings {
  mode: CacheTtlMode;
  /** 保活总开关。Default true. */
  keepalive: boolean;
  /** ping 间隔（内部 ms；文件存 keepaliveIntervalS 秒）。Default 240_000 (240s)，钳位 [60s, 240s]
   *  （`MAX_SAFE_KEEPALIVE_INTERVAL_MS`：曾允许到 280s，但那正是 plan.md §6.1 明确否决的取值——
   *  相对 `ASSUMED_TTL_MS − TTL_SAFETY_MARGIN_MS` 只剩负余量，永远到不了 evaluateTick 的 #15，
   *  一律在 #13 被判 cache-expired，即配置了也永不 ping；todo #15 真机验收复查时发现，2026-09-27）。 */
  keepaliveIntervalMs: number;
  /** Status-only migration note: finite legacy value, or "invalid" when the removed key exists.
   * Never controls keepalive or the dynamically priced cap; absent unless the old key is present.
   */
  readonly legacyKeepaliveMaxPings?: number | "invalid";
  /** 前缀实测下界门槛（tokens）。Default 20000。 */
  keepaliveMinPrefixTokens: number;
  /** child-ka-core（docs/dev/child-context-switch/plan.md §2.4/§4）：子会话保活总开关。
   *  Default true；false ⇒ 子会话不注册 capture/keepalive，不写审计条目，无网络（还受上面的
   *  `keepalive` 总开关约束）。 */
  childKeepalive: boolean;
  /** 每 run（累计所有窗口）proven-hit ping 上限；`0` = 子会话不 ping。Default 24。 */
  childKeepaliveMaxPingsPerRun: number;
  /** 全进程子会话保活并发上限。Default 4，钳位 [1, 32]。 */
  childKeepaliveMaxConcurrent: number;
  /** 每 run 的保活美元预算；`0` = 子会话不 ping。Default 1.5，钳位 [0, 1000]。 */
  childKeepaliveRunBudgetUsd: number;
  /** 全进程滚动 24h 保活美元预算；`0` = 子会话不 ping。Default 10，钳位 [0, 10000]。 */
  childKeepaliveProcessBudgetUsd: number;
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
  /** 请教 run 的固定截止（budgetOverride.totalMs 且无 timeoutPolicy ⇒ 解析为 fixed，maxTotalFactor=1，无宽限无延长）。Default 150s。 */
  timeoutMs: number;
  /** 回答截断上限（同时写进问题 prompt 的指令）。Default 6000。 */
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
 * 按窗口区分后的一组阶梯阈值（quota-plan「阶梯阈值按窗口区分」）：已在
 * parseQuotaSettings 里钳制完毕 l1<=l2<=l3，消费方（service.ts、render.ts）
 * 直接取用、无需再校验。
 */
export interface QuotaWindowThresholds {
  readonly l1Percent: number;
  readonly l2Percent: number;
  readonly l3Percent: number;
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
  /** L1 提示阈值（used %）。当 `quota.windows[scope]` 未覆盖某窗口时，两窗口共用本字段（向后兼容）。 */
  l1Percent: number;
  /** L2 建议阈值（used %）。同上兼容语义。 */
  l2Percent: number;
  /** L3 强烈阈值（used %）。同上兼容语义。 */
  l3Percent: number;
  /** ETA 低于此值直接判 L3。两窗口相同、不随窗口区分。 */
  l3EtaMs: number;
  /**
   * 按窗口区分的最终解析阈值（quota-plan「阶梯阈值按窗口区分」）：5h 与 week
   * 各自的 l1<=l2<=l3 已在 parseQuotaSettings 钳制完毕——service.ts / render.ts
   * 直接按 `windows[scope]` 取值，不必再理解上面三个全局字段的兼容规则。
   * 优先级（parseQuotaSettings 落地）：`quota.windows.<scope>.*` > 显式设置的
   * 全局 `l1Percent/l2Percent/l3Percent`（对两窗口同时生效）> 按窗口仓库默认
   * （ladder.ts 的 DEFAULT_THRESHOLDS_BY_WINDOW）。
   */
  windows: Readonly<Record<WindowScope, QuotaWindowThresholds>>;
  /** L1 tick 的 usedPct 网格步；0 = 关闭网格闸（只剩等级闩锁）。 */
  tickStepPercent: number;
  /** 两条 quota 消息之间的全局最小间隔（L3 不受限）。 */
  minIntervalMs: number;
  /** L3 的复读周期；L2 纯提示不复读。 */
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
  /** Factory 计费接口（droid 池，D17）；私有部署逃生阀，JSON-file-only。 */
  factoryBaseUrl: string;
  /** D6 拍板：standard 池耗尽且超额策略为 extraUsage 时是否放行（默认不放行——不代用户花真钱）。 */
  droidAllowExtraUsage: boolean;
  /** 模型 → 池的人工覆盖（R1 启发式误判的纠错主通道）；键是 droid 模型 id，值 standard|core|none。JSON-file-only。 */
  droidPools: Readonly<Record<string, QuotaPoolId | "none">>;
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
 * L1 (agent-tool pool-full plan §2): top-level/nested Agent tool dispatch
 * policy when the concurrency pool is already full. Default is `false`
 * (reject immediately, no queueing); `true` restores the pre-L1 queue-wait
 * behavior (subject to `budget.queueWaitS`'s own timeout). Workflow children
 * (src/workflow/) and every other spawn path (consult, /task, resume) never
 * read this setting — they always queue, unaffected by this toggle.
 */
export interface AgentDispatchSettings {
  queueWhenFull: boolean;
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

/**
 * 会话标题模型生成 v2（任务 #12 + 随任务动态刷新，r1 评审裁定）：会话未命名时
 * 用 before_agent_start 生成 ≤20 字首标；之后按里程碑（新增用户输入数/累计
 * 运行时长）在 agent_settled 刷新——但只刷新自己写的标题，用户 /name 过的
 * 永久不再动。`enabled`/`model` 是 v1 既有两键，三个新键是刷新里程碑/额度。
 * 失败静默、在途互斥、过期结果隔离、所有权判定由模块不变量保证
 * （src/title/title.ts），不是设置项。逐字段容错解析见 parseTitleSettings
 * （never throws）。非 live（activate 时捕获，改后 /reload）。
 */
export interface TitleSettings {
  /** 总开关。false = 不注册任何 handler（行为与功能不存在时逐字节相同）。Default true。 */
  enabled: boolean;
  /**
   * 标题模型，strict `provider/id`；空串 = 跟随当前会话模型。默认
   * `zai-coding-cn/glm-5.3-flash`：订阅线（quota.providers 同源）里最便宜最快的
   * flash 档——本机订阅单价 $0.12/M in、$0.42/M out（订阅额度内边际成本为 0），
   * 一次标题 ≤512 token，成本可忽略；解析失败/异机无此 provider 时同样回落
   * 当前会话模型（memory.tidy.model 同款约定）。
   */
  model: string;
  /** 自上次生成以来新增用户输入数达到此值即可刷新；0 = 关闭此条件。默认 4。 */
  refreshEveryInputs: number;
  /** 新增用户输入 ≥1 且累计运行时长（分钟）达到此值即可刷新；0 = 关闭此条件。默认 15。 */
  refreshAfterMinutes: number;
  /**
   * `maxRefreshes` 的滚动统计窗口（分钟）：只统计这个窗口内的刷新次数，超出窗口的旧刷新
   * 不再计入额度（窗口滑走后又可以刷新，长会话的标题不会永久冻结）。`0` = legacy 口径，
   * `maxRefreshes` 退化为整个会话生命周期的上限（与引入本字段前逐字节相同）。默认 60。
   */
  refreshWindowMinutes: number;
  /**
   * 每 `refreshWindowMinutes` 窗口（或整个会话生命周期，当窗口=0）内的刷新上限（不含首标）；
   * 0 = 只首标不刷新。默认 5。
   */
  maxRefreshes: number;
}

/**
 * sysload plan §6.1: hint-ladder sub-block of `LoadSettings` (§6.4 notification ladder).
 * Parsed by `parseLoadSettings` below, never standalone.
 */
export interface LoadHintSettings {
  /** Master switch for the recovery-slot machinery (§6.4). `false` ⇒ no slot is ever armed,
   * and reject copy stops promising a future hint (§6.4). Default true. */
  enabled: boolean;
  /** Whether the injected `subagent:load` message is visible in the transcript. Default true. */
  display: boolean;
  /** crit re-announce period (§6.4); warn announces once per escalation. Default 600000 (10min). */
  repeatMs: number;
  /** Global floor between two load messages (crit + the recovery hint bypass it). Default 120000 (2min). */
  minIntervalMs: number;
}

/**
 * Load-aware dispatch (docs/dev/sysload/plan.md §6.1). Parsed field-by-field, never throws, by
 * `parseLoadSettings`. Non-live: captured at `session_start`, changed only by `/reload` (the hub
 * side additionally needs `/webhub restart` — §6.1). `cpu`/`mem`/`disk` reuse the pi-free
 * threshold shapes frozen in `src/sysload/types.ts` so the tracker (P1) and this settings layer
 * never drift on field names.
 */
export interface LoadSettings {
  /** Master switch (§1/§6.1). `false` ⇒ no sampler, no hook, no gate — byte-identical to
   * pre-feature (§8 I8). Default true. */
  enabled: boolean;
  /** Spawn-admission / workflow-queue gate switch (§5.3). `false` ⇒ the effective gate is
   * always false: no reject, no queue, no banner — only HUD/hint copy keeps working, worded as
   * "仅提示" (§5.3). Default true. */
  gate: boolean;
  /** Minimum overall level that counts as "gating" in §5.3's effective-gate formula. Default
   * `"crit"` (§6.1); `"warn"` is the more aggressive opt-in. */
  gateLevel: "crit" | "warn";
  /** Sampler tick period. Range `[2000,60000]` (§5.2). Default 5000. */
  sampleIntervalMs: number;
  /** §5.2 upgrade proof window; `0` = first valid sample upgrades immediately. Range
   * `[0, 120×sampleIntervalMs]`. Default 60000. */
  sustainMs: number;
  /** §5.2 recovery proof window. Range `[sampleIntervalMs, 120×sampleIntervalMs]`. Default 30000. */
  recoverMs: number;
  cpu: LoadCpuThresholds;
  mem: LoadMemThresholds;
  disk: LoadDiskThresholds;
  /** §6.4 notification ladder sub-block. */
  hint: LoadHintSettings;
  /** HUD status key (§3/§6.1). Default true. */
  hud: boolean;
}

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
  /** consult：轮内同步请教（consult plan §4.6）。 */
  consult: ConsultSettings;
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
}

/** Simple on/off settings group shared by the merged plugins (webSearch / todo). */
export interface EnabledGroup {
  enabled: boolean;
}

// ── 流量录制（traffic-merge plan §2.2）：设置形状 / 默认值 / 解析。全部非 live。 ──

export interface TrafficWebSettings {
  /** 绑定地址（拍板②）：默认仅回环；`"0.0.0.0"` = LAN 显式 opt-in。 */
  host: "127.0.0.1" | "0.0.0.0";
  /** 起始端口（占用自增，最多 20 次）。 */
  port: number;
}
export interface TrafficSettings {
  /** 总开关，默认 false。off ⇒ 不调用任何 wire 函数；secure/locked 域强制 false（§6）。 */
  enabled: boolean;
  /** 子会话请求是否落库（拍板①，默认 true）：为 false 时子会话钩子仍注册（票据仍用于改写归属），只是不写行。 */
  childSessions: boolean;
  web: TrafficWebSettings;
}
export const DEFAULT_TRAFFIC_SETTINGS: TrafficSettings = {
  enabled: false,
  childSessions: true,
  web: { host: "127.0.0.1", port: 4177 },
};
/** 解析 `traffic` 组：逐字段回落默认，永不抛错（web.host 只接受两个枚举值，端口整数 1024..65535）。 */
export function parseTrafficSettings(input: unknown): TrafficSettings {
  const d = DEFAULT_TRAFFIC_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...d, web: { ...d.web } };
  const value = input as Record<string, unknown>;
  const webInput = value.web;
  const web =
    webInput && typeof webInput === "object" && !Array.isArray(webInput) ? (webInput as Record<string, unknown>) : {};
  const host = web.host;
  const port = web.port;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : d.enabled,
    childSessions: typeof value.childSessions === "boolean" ? value.childSessions : d.childSessions,
    web: {
      host: host === "0.0.0.0" ? "0.0.0.0" : d.web.host,
      port: typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : d.web.port,
    },
  };
}

// ── 外部 agent（external-agent plan §2.8，冻结面）：设置形状 / 默认值 / 解析 ──

export type ExternalProtocolCheck = "strict" | "warn";
/** "provider/id"（用该 pi 模型的价格）| "unpriced" | 显式单价（USD/1M，四项必填、有限、≥0）。 */
export type DroidPricingOverride = string | ExternalPriceRates;
export interface DroidAgentSettings {
  enabled: boolean; // 默认 false；非 live（stack 构建时读）
  binary: string; // 默认 "droid"；非 live
  protocolCheck: ExternalProtocolCheck; // 默认 "strict"；非 live
  models: string[]; // 提示词展示的 droid 模型 id；[] = 自动
  advertiseMax: number; // 默认 12，整数 0..50
  injectMemory: boolean; // 默认 true（U5）
  pricing: Record<string, DroidPricingOverride>; // 默认 {}；键 = droid 模型 id
  catalogTtlMs: number; // 文件键 catalogTtlS，默认 86400s，60s..30d
  requestTimeoutMs: number; // 文件键 requestTimeoutS，默认 15s，1..120s
  initTimeoutMs: number; // 文件键 initTimeoutS，默认 20s，5..120s
  killGraceMs: number; // 文件键 killGraceS，默认 2s，0.2..30s
}
export interface ExternalAgentsSettings {
  droid: DroidAgentSettings;
}
export const DEFAULT_EXTERNAL_AGENTS_SETTINGS: ExternalAgentsSettings = {
  droid: {
    enabled: false,
    binary: "droid",
    protocolCheck: "strict",
    models: [],
    advertiseMax: 12,
    injectMemory: true,
    pricing: {},
    catalogTtlMs: 86_400_000,
    requestTimeoutMs: 15_000,
    initTimeoutMs: 20_000,
    killGraceMs: 2_000,
  },
};
/** droid 模型 id / pricing 键的合法字符集（§2.8）。 */
const EXTERNAL_MODEL_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** 解析 externalAgents 块：未知键忽略；逐项非法回退默认；never throws。关闭态字节一致要求：
 *  迁移（migrateSettingsFileTimeUnits）只转换文件里已存在的键，缺 externalAgents 的文件不写入任何新键。 */
export function parseExternalAgentsSettings(input: unknown): ExternalAgentsSettings {
  const defaults = DEFAULT_EXTERNAL_AGENTS_SETTINGS.droid;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { droid: { ...defaults } };
  const droid = (input as Record<string, unknown>).droid;
  if (!droid || typeof droid !== "object" || Array.isArray(droid)) return { droid: { ...defaults } };
  const value = droid as Record<string, unknown>;
  // 时长（内部毫秒）：非有限数或越界 ⇒ 回默认（不静默 clamp，parseBashJobsSettings 同款）。
  const duration = (raw: unknown, fallback: number, min: number, max: number): number => {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max) return fallback;
    return raw;
  };
  const binary =
    typeof value.binary === "string" && value.binary.length > 0 && !value.binary.includes("\0")
      ? value.binary
      : defaults.binary;
  const models: string[] = [];
  if (Array.isArray(value.models)) {
    for (const id of value.models) {
      if (typeof id === "string" && EXTERNAL_MODEL_KEY_RE.test(id) && !models.includes(id)) models.push(id);
      if (models.length >= 50) break;
    }
  }
  const pricing: Record<string, DroidPricingOverride> = {};
  if (value.pricing && typeof value.pricing === "object" && !Array.isArray(value.pricing)) {
    for (const [id, raw] of Object.entries(value.pricing as Record<string, unknown>)) {
      if (!EXTERNAL_MODEL_KEY_RE.test(id)) {
        console.warn(`[pi-subagent] externalAgents.droid.pricing.${id} ignored: invalid model id`);
        continue;
      }
      let ok = false;
      if (raw === "unpriced" || (typeof raw === "string" && parseStrictModelRef(raw) !== undefined)) ok = true;
      else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const r = raw as Record<string, unknown>;
        const rate = (k: string): boolean => typeof r[k] === "number" && Number.isFinite(r[k]) && r[k] >= 0;
        ok = rate("input") && rate("output") && rate("cacheRead") && rate("cacheWrite");
      }
      if (ok) pricing[id] = raw as DroidPricingOverride;
      else
        console.warn(
          `[pi-subagent] externalAgents.droid.pricing.${id} ignored: expected "unpriced", a strict provider/id, or explicit USD/1M rates`,
        );
    }
  }
  return {
    droid: {
      enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
      binary,
      protocolCheck:
        value.protocolCheck === "warn" || value.protocolCheck === "strict"
          ? value.protocolCheck
          : defaults.protocolCheck,
      models,
      advertiseMax:
        typeof value.advertiseMax === "number" &&
        Number.isInteger(value.advertiseMax) &&
        value.advertiseMax >= 0 &&
        value.advertiseMax <= 50
          ? value.advertiseMax
          : defaults.advertiseMax,
      injectMemory: typeof value.injectMemory === "boolean" ? value.injectMemory : defaults.injectMemory,
      pricing,
      catalogTtlMs: duration(value.catalogTtlMs, defaults.catalogTtlMs, 60_000, 2_592_000_000),
      requestTimeoutMs: duration(value.requestTimeoutMs, defaults.requestTimeoutMs, 1_000, 120_000),
      initTimeoutMs: duration(value.initTimeoutMs, defaults.initTimeoutMs, 5_000, 120_000),
      killGraceMs: duration(value.killGraceMs, defaults.killGraceMs, 200, 30_000),
    },
  };
}

/**
 * ask-user background interrupt (docs/dev/ask-user-async/plan.md §5.2.1/§6.1,
 * P2): main-session TUI default ON, RPC default OFF (rpc=true 只提供中途打断，
 * 已知限制：pi 不向客户端发撤回，对话框残留——plan §7.1). All four durations
 * are stored in the settings FILE as integer seconds under the `*S` name
 * (registered in TIME_SETTING_MS_PATHS) and parsed into internal milliseconds;
 * per-field fallback on any illegal value (non-number / NaN / non-finite /
 * non-integer / out of range), never throws — parseHudSettings 同款。
 * `maxDeferMs < quietMs` is clamped UP to quietMs (plan §5.2.1).
 */
export interface AskUserBackgroundInterruptSettings {
  /** Master switch for the background-completion interrupt (main-session TUI). Default true. */
  enabled: boolean;
  /** 合并窗口：首个完成到达后合并后续完成的窗口。默认 1s，合法 0–10s（0 = 下一个宏任务）。 */
  delayMs: number;
  /** 安静期：最后一次按键后等待多久才落下打断。默认 4s，合法 0–30s（0 = 无活跃保护）。 */
  quietMs: number;
  /** 活跃推迟上限：窗口到点后因持续打字最多再推迟。默认 20s，合法 0–120s，钳为 ≥ quietMs。 */
  maxDeferMs: number;
  /** 驻留期：重问框挂载后不落下打断的宽限。默认 10s，合法 0–60s（0 = 无驻留）。 */
  reaskDwellMs: number;
  /** 每题打断预算（用户拍板 3）：耗尽后回到今天的阻塞行为（已接受的降级，§5.2.4）。合法 1–10。 */
  maxPerQuestion: number;
  /** RPC 模式是否提供中途打断（默认 false；关 = RPC 路径与今天逐字节一致，plan §7.1）。 */
  rpc: boolean;
}

/** Merged ask_user settings: EnabledGroup + the background-interrupt sub-block. */
export interface AskUserSettings extends EnabledGroup {
  backgroundInterrupt: AskUserBackgroundInterruptSettings;
}

/**
 * Main-session todo staleness nudge (L1 feature). All four counters are turn
 * counts, never durations, so they are excluded from the time-unit `*Ms`/`*S`
 * migration — a plain integer setting stays a plain integer setting.
 * `enabled:false` registers zero new handlers/messages (behavior identical to
 * before the feature existed); the nudge tracker is main-session only
 * (child subagent sessions never enable it — src/index.ts's `isChildSession`).
 */
export interface TodoNudgeSettings {
  enabled: boolean;
  /** Turns to wait, from the FIRST unconfirmed E1/E2 evidence, before firing the evidence-based trigger. */
  graceTurns: number;
  /** Turns with zero evidence before the fallback trigger fires. */
  fallbackTurns: number;
  /** Turns to suppress re-nudging after a nudge fires; doubles per consecutive no-touch nudge, capped at 4x. */
  cooldownTurns: number;
}

/** Merged plugins: TaskCreate/List/Get/Update/Delete + /tasklist widget, plus the staleness nudge sub-block. */
export interface TodoSettings extends EnabledGroup {
  nudge: TodoNudgeSettings;
  /** Completed-task auto-archive (todo-archive plan D1). Both knobs are non-live (/reload). */
  archive: TodoArchiveSettings;
}

/**
 * Completed-task auto-archive (todo-archive plan §2, user ruling 2026-10-15): `onCompact` sweeps
 * every completed task when the session compacts; `afterTurns` archives a completed task on the
 * Nth `turn_end` after its completion (turns are finer-grained than user requests — tune N
 * accordingly). Both are turn/compaction-count semantics, never durations, so like the nudge
 * block they stay out of the `*Ms`/`*S` time-unit migration. Non-live: read at wiring time only.
 */
export interface TodoArchiveSettings {
  /** Archive all completed tasks on session compaction. Default true. */
  onCompact: boolean;
  /** Archive a completed task after this many turn_end events; 0 disables the per-turn sweeper. Default 30, min 0. */
  afterTurns: number;
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
  /** Sender-controlled wake / revive of finished sub-agents (fabric-cross-session plan v3 §4.8); phase-1 (in-tree) leaves only. */
  wake: FabricWakeSettings;
  /** fabric phase-2 (phase2-plan §4.1): cross-session root↔root messaging; `xsOn` additionally
   * requires `fabric.enabled` ∧ `webHub.enabled` ∧ `webHub.control !== false` (frozen at activate). */
  crossSession: FabricCrossSessionSettings;
}
/**
 * `fabric.wake.*` (plan v3 §4.8, Q2): only effective while `fabric.enabled` is also on; read once at stack build
 * (non-live). `rootRunMaxS` (phase2 §4.1) bounds ONLY the cross-session RootWakeController — the phase-1
 * tree-internal wake path never goes through the Controller (ruling P7) and is unaffected by the key.
 */
export interface FabricWakeSettings {
  /** Default on (Q2) — gated behind `fabric.enabled`, which defaults off, so a default install is unchanged. */
  enabled: boolean;
  /** Causal wake-chain ceiling (Q9): a wake with `level+1 > maxLevel` degrades to deliver-only. */
  maxLevel: number;
  /** Per sender run: how many `wake:true` sends may be effective. */
  perRunQuota: number;
  /** Fixed budget (seconds) of a revived run; parse-time clamped to 60..3600. */
  resumeBudgetS: number;
  resumesPerHour: number;
  resumesPerTargetPerHour: number;
  /** Max parked messages per finished target. */
  parkCapPerTarget: number;
  /** Cross-session Controller watchdog, measured from DISPATCH (phase2 §4.1/§6.2); parse-time
   * clamped to 60..3600, `0` = Controller off ⇒ cross-session `wake:true` degrades to deliver-only. */
  rootRunMaxS: number;
}
/** Parse-time bounds for `fabric.wake.resumeBudgetS` (plan §4.8). */
export const FABRIC_WAKE_RESUME_BUDGET_MIN_S = 60;
export const FABRIC_WAKE_RESUME_BUDGET_MAX_S = 3600;
/** Parse-time bounds for `fabric.wake.rootRunMaxS` (phase2 §4.1: 60..3600, 0 = off). */
export const FABRIC_WAKE_ROOT_RUN_MIN_S = 60;
export const FABRIC_WAKE_ROOT_RUN_MAX_S = 3600;

/** `fabric.crossSession.receive` (phase2 §4.1, P2: joined sessions default to `wake`).
 *  Reply-plan §8.1/R1 (RX0): `"replies"` = accept ONLY replies bound to this session's own
 *  pending requests. This union is the PREFERENCE — every consumer reads the EFFECTIVE value
 *  from `effectiveReceive` (`replies` unavailable ⇒ `off`; it NEVER falls back to `wake`). */
export type FabricXsReceiveMode = "off" | "deliver" | "wake" | "replies";

/**
 * `effectiveReceive` (reply-plan §8.1, RX0 — the ONE downgrade rule, a pure function):
 * `replies` with the reply feature unavailable ⇒ `off`. Never `wake`, never any other value —
 * fail closed, same direction as the membership-entry `receivePref` persistence.
 */
export function effectiveReceive(pref: FabricXsReceiveMode, replyEnabled: boolean): FabricXsReceiveMode {
  return pref === "replies" && !replyEnabled ? "off" : pref;
}

/** Parse-time bounds for `fabric.crossSession.reply.*` (reply-plan §8.1). */
export const FABRIC_XS_REPLY_MIN_TIMEOUT_S = 60;
export const FABRIC_XS_REPLY_MAX_TIMEOUT_S = 86_400;
export const FABRIC_XS_REPLY_MAX_PENDING_MIN = 1;
export const FABRIC_XS_REPLY_MAX_PENDING_MAX = 32;
export const FABRIC_XS_REPLY_MAX_PENDING_PER_TARGET_MIN = 1;
export const FABRIC_XS_REPLY_MAX_PENDING_PER_TARGET_MAX = 8;
export const FABRIC_XS_REPLY_LATE_GRACE_MIN_S = 0;
export const FABRIC_XS_REPLY_LATE_GRACE_MAX_S = 3_600;

/**
 * `fabric.crossSession.reply.*` (reply-plan §8.1/§3.4, RX0): request-reply association tuning.
 * Field-by-field tolerant, never throws; every numeric leaf parse-time clamped to its bounds.
 * Non-live (read once at stack build, like the rest of `fabric.crossSession.*`).
 */
export interface FabricXsReplySettings {
  /** Default on — the feature rides the four xs switches (`xsOn`) on top of this leaf. */
  enabled: boolean;
  /** Default `expectReply.timeoutS` when the caller passes no timeout (seconds). */
  defaultTimeoutS: number;
  /** Ceiling for an explicit `expectReply.timeoutS` (seconds). */
  maxTimeoutS: number;
  /** Per-session cap: receivable-or-consuming tickets + replyInbox occupancy (§3.4). */
  maxPending: number;
  /** Per-target cap: receivable-or-consuming tickets issued towards one session (§3.4). */
  maxPendingPerTarget: number;
  /** Late-grace window after the timeout within which a reply is still delivered (§7.3). */
  lateGraceS: number;
}

/** Parse-time bounds for `fabric.crossSession.channels.broadcast.*` (channel-plan §6.4). The two
 *  wake leaves' maxima are HARD ceilings (Q5): settings can only tighten them. */
export const FABRIC_XS_BROADCAST_OUT_PER_HOUR_MAX = 60;
export const FABRIC_XS_BROADCAST_MIN_INTERVAL_MIN_S = 10;
export const FABRIC_XS_BROADCAST_MIN_INTERVAL_MAX_S = 3_600;
export const FABRIC_XS_BROADCAST_WAKE_OUT_PER_HOUR_MAX = 2;
export const FABRIC_XS_BROADCAST_MAX_RECIPIENTS_MIN = 2;
export const FABRIC_XS_BROADCAST_MAX_RECIPIENTS_MAX = 32;
export const FABRIC_XS_BROADCAST_WAKE_MAX_RECIPIENTS_MAX = 4;

/** `fabric.crossSession.channels.broadcast.*` (channel-plan §6.4). */
export interface FabricXsBroadcastSettings {
  /** Per-session broadcasts per hour (rides `xs_member.limits`); 0 = broadcasting forbidden. */
  outPerHour: number;
  /** Minimum seconds between two broadcasts of one session. */
  minIntervalS: number;
  /** Broadcast wakes per hour per session — HARD max 2 (Q5). */
  wakeOutPerHour: number;
  /** Hub-global recipient ceiling (rides `HubConfig`). */
  maxRecipients: number;
  /** Hub-global wake recipient ceiling — HARD max 4 (Q5). */
  wakeMaxRecipients: number;
}

/** `fabric.crossSession.channels.*` (channel-plan §6.4, non-live). */
export interface FabricXsChannelSettings {
  /** Q6: default true. false ≡ an old agent: no cap, no channel tools, named channels suspended. */
  enabled: boolean;
  /** Canonical, de-duplicated, ≤4 names that `autoJoin` joins (default `["default"]`). */
  autoJoin: string[];
  /** §2.4: the configured `autoJoin` was a non-empty array whose entries were ALL invalid ⇒ join nothing and say so in status. */
  autoJoinInvalid: boolean;
  broadcast: FabricXsBroadcastSettings;
}

/** Parse-time bounds for `fabric.crossSession.alias.*` (alias-plan §3.6). `takeMinOfflineMin`'s floor IS NQ1
 *  (take needs the holder offline ≥10 min — it can never be tuned down to 0). */
export const FABRIC_XS_ALIAS_OFFLINE_LEASE_H_MIN = 1;
export const FABRIC_XS_ALIAS_OFFLINE_LEASE_H_MAX = 720;
export const FABRIC_XS_ALIAS_COOL_MIN_MIN = 1;
export const FABRIC_XS_ALIAS_COOL_MIN_MAX = 1_440;
export const FABRIC_XS_ALIAS_TAKE_MIN_OFFLINE_MIN_MIN = 10;
export const FABRIC_XS_ALIAS_TAKE_MIN_OFFLINE_MIN_MAX = 1_440;

/** `fabric.crossSession.alias.*` (alias-plan §3.6, non-live). */
export interface FabricXsAliasSettings {
  /** Q9: default true. false ≡ an old agent: no cap, no alias resolution, `/fabric alias` refused locally. */
  enabled: boolean;
  /** Q2: hours an offline holder keeps its alias (default 168 = 7 d). Rides `HubConfig.crossSession.alias`. */
  offlineLeaseH: number;
  /** Q4: minutes a cleared/renamed alias stays reserved for its former holder (default 10). */
  coolMin: number;
  /** NQ1: minutes a holder must be offline before `--take` (default 10, floor 10). */
  takeMinOfflineMin: number;
}

/** `fabric.crossSession.limits.*` (phase2 §5.2, P8 defaults; every leaf parse-time clamped to its bounds). */
export interface FabricCrossSessionLimitsSettings {
  /** Per-session outbound sends per minute (sender + hub). */
  sendsOutPerMin: number;
  /** Per-session outbound sends per hour (sender + hub). */
  sendsOutPerHour: number;
  /** Per-session outbound wakes per hour (sender + hub); 0 = deliver-only. */
  wakesOutPerHour: number;
  /** Per-session inbound messages per hour (receiver only). */
  recvPerHour: number;
  /** Per-session inbound wakes per hour (receiver only); 0 = deliver-only. */
  wakesInPerHour: number;
  /** Cross-session inbox cap — independent of the tree-internal `rootInboxCap` (review #7). */
  inboxCap: number;
  /** Minimum interval between one session pair (sender + hub). */
  pairMinIntervalMs: number;
  /** Wakes per hour between one session pair (sender + hub). */
  pairWakesPerHour: number;
  /** Concurrent in-flight sends per session (sender + hub). */
  inFlightPerSession: number;
  /** Global hub-side sends per minute (HubConfig, frozen at hub start). */
  hubSendsPerMin: number;
  /** list + resolve calls per minute (sender + hub). */
  listPerMin: number;
}

/**
 * `fabric.crossSession.*` (phase2 §4.1): non-live, field-by-field tolerant, never throws.
 * `allowFrom` keeps only FULL session ids (pi `assertValidSessionId`'s rule); invalid entries are
 * dropped with one console.warn, and a non-empty-but-all-invalid list sets `allowFromDenyAll`
 * (review #14: fail closed — reject every sender, mirroring `webHub.lan.allowClients`).
 */
export interface FabricCrossSessionSettings {
  enabled: boolean;
  /** P1: sessions never join implicitly; `true` joins every new main session at startup. */
  autoJoin: boolean;
  /** P2: joined sessions default to wake (overridable per session via `/fabric receive`). */
  receive: FabricXsReceiveMode;
  /** Empty + `allowFromDenyAll === false` ⇒ any joined session may send here. */
  allowFrom: string[];
  /** #14 fail-closed marker: the configured allowFrom was non-empty but every entry was invalid. */
  allowFromDenyAll: boolean;
  limits: FabricCrossSessionLimitsSettings;
  /** Reply-plan §8.1 (RX0): request-reply association settings (present in every parsed
   *  block — `receive:"replies"` availability is judged against `reply.enabled` only through
   *  `effectiveReceive`, never by rewriting the stored preference). */
  reply: FabricXsReplySettings;
  /** Channel-plan §6.4 (CH0): channels + broadcast settings (present in every parsed block). */
  channels: FabricXsChannelSettings;
  /** Alias-plan §3.6 (AL0b): session alias settings (present in every parsed block). */
  alias: FabricXsAliasSettings;
}

/**
 * Full session-id shape, mirroring pi 1.3's `assertValidSessionId` regex
 * (`node_modules/…/dist/core/session-manager.js`): non-empty, only `[A-Za-z0-9._-]`, must start
 * and end with an alphanumeric. Kept as a local literal — `src/config/settings.ts` has a frozen
 * value-import closure (`tests/web-hub/boundary.test.ts` SYSLOAD_FILE_CLOSURE) and gains nothing.
 */
export const FABRIC_XS_SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Validate one `allowFrom` entry (review #14): full session ids only. */
export function isValidXsSessionId(id: string): boolean {
  return FABRIC_XS_SESSION_ID_RE.test(id);
}
/** 动态阈值默认值（§11.2）：mode 默认 on（用户拍板 D1）；maxQualityPercent/rediscoveryUsd 均未校准。 */
export const DEFAULT_DYNAMIC_THRESHOLD_SETTINGS: DynamicThresholdSettings = {
  mode: "on",
  minHintPercent: 35,
  maxQualityPercent: 60,
  rediscoveryUsd: 10,
  unknownPriceMode: "static",
};

/**
 * `webHub.lan.*` defaults (lan-plan.md sec 9.1 / sec 11 W3-LI): all five keys are non-live
 * (captured at activate; change -> /reload). `extraHosts`/`trustProxyFrom`/`externalOrigins` are
 * comma-separated strings on disk (sec 9.1's table) and are validated into this `string[]` shape
 * (LE's frozen `WebHubLanSettings`, fed straight into `HubLanConfig`) by `parseWebHubLanBlock`.
 */
export const DEFAULT_WEBHUB_LAN_SETTINGS: WebHubLanSettings = {
  enabled: false,
  port: 7879,
  extraHosts: [],
  trustProxyFrom: [],
  externalOrigins: [],
  allowClients: [],
  sessionIdleMinutes: 720,
};

/**
 * `webHub.proxy.*` defaults (web-hub-proxy plan v2 §0/§5): off by default ⇒ `HubConfig.proxy` is
 * never constructed and the hub is byte-identical. The literals mirror `protocol/proxy.ts`
 * (`PROXY_DEFAULT_PORT_RANGE_TEXT` / `PROXY_DEFAULT_MAX_PROXIES`) — this module may not
 * value-import it (`tests/web-hub/boundary.test.ts` freezes its import closure), so
 * `tests/web-hub/protocol/proxy.test.ts` pins the two copies equal.
 */
export const DEFAULT_WEBHUB_PROXY_SETTINGS: WebHubProxySettings = {
  enabled: false,
  portRange: "7900-7949",
  maxProxies: 8,
};

/**
 * `feishuBot.*` defaults (feishu-bot plan v2 §9): off by default ⇒ nothing is wired. Literal mirrors of
 * `protocol/feishu.ts`'s `FEISHU_BOT_DEFAULTS` / `FEISHU_BOT_RANGES` (this module may not value-import
 * it — `tests/web-hub/boundary.test.ts` freezes its import closure), pinned equal by
 * `tests/web-hub/protocol/feishu.test.ts`.
 */
export const DEFAULT_FEISHU_BOT_SETTINGS: FeishuBotSettings = {
  enabled: false,
  allowGroups: true,
  groupRootTopics: false,
  securityAlerts: true,
  xsMirror: true,
  notify: "bound",
  spawnScope: "known",
  debounceMs: 1_500,
  staleMessageS: 300,
  files: { outbound: "auto", inbound: true, maxInboundMiB: 30 },
};

/**
 * `webHub.spawn.*` defaults（web-hub-spawn arch v2 §6.2 / plan §SP2）：与 lan 块同为非 live——
 * activate 时捕快照，改动需 `/reload` 后再 `/webhub restart` 才到达运行中的 hub（它们只随
 * `PI_WEBHUB_CONFIG` 传输）。默认 `enabled:false` ⇒ `HubConfig.spawn` 不被构造（arch §8.2
 * 未启用矩阵）。数值范围见 `parseWebHubSpawnBlock`（越界钳制、非法回落）。
 */
export const DEFAULT_WEBHUB_SPAWN_SETTINGS: WebHubSpawnSettings = {
  enabled: false,
  roots: [],
  maxProcesses: 4,
  maxPerPrincipal: 2,
  ratePerMinute: 3,
  maxLifetimeMinutes: 720,
  registerTimeoutS: 30,
  lan: "off",
  // web-hub-spawn-restore plan D18: restore managed sessions across hub restarts — default ON,
  // effective only under an explicitly enabled spawn block.
  restore: true,
  // web-hub-session-history plan §3.7 (P-cfg): browse all past sessions and resume/fork them
  // from the web — default ON, effective only under an explicitly enabled spawn block.
  history: true,
  // 2026-10-13 用户拍板（U1 单用户信任模型既判）: LAN 每次 spawn 的 E_CONFIRM_REQUIRED 确认门
  // 默认 ON（现状）；设为 false 即明示放弃这层 LAN 渠道证明（已知目录/历史会话直达 202，
  // 未知目录仍需确认；session-open 的 fork 决策不在豁免范围）。
  lanConfirm: true,
};

export const DEFAULT_SETTINGS: AgentSettings = {
  concurrencyLimit: 6,
  agent: { queueWhenFull: false },
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
  workflow: {
    enabled: false,
    budget: {},
    replayTtlMs: 7 * 24 * 60 * 60 * 1_000,
    replayScope: "chain",
    runawayPolicy: "diagnose_only",
    isolationReplay: "verify",
  },
  bashJobs: {
    autoBackgroundMs: 290_000,
    maxLogBytes: 10_485_760,
    maxBackgroundJobs: 8,
    retentionMs: 24 * 60 * 60 * 1_000,
    drainTimeoutMs: 30_000,
    shutdownPolicy: "keep",
    childSessions: true,
    childSettleHold: true,
    childSettleHoldMaxRounds: 0,
    timeoutGraceMs: 60_000,
    maxExtensions: 3,
    maxTimeoutFactor: 3,
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
    childSessions: true,
    childMaxSwitches: 5,
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
    wake: {
      enabled: true,
      maxLevel: 2,
      perRunQuota: 3,
      resumeBudgetS: 600,
      resumesPerHour: 6,
      resumesPerTargetPerHour: 2,
      parkCapPerTarget: 8,
      rootRunMaxS: 900,
    },
    // fabric phase-2 (phase2-plan §4.1/§5.2, rulings P1/P2/P8 + review #7): OFF by default —
    // `crossSession` exists in every parsed FabricSettings, but `xsOn` stays false until the
    // operator enables fabric + crossSession + webHub.
    crossSession: {
      enabled: false,
      autoJoin: false,
      receive: "wake",
      allowFrom: [],
      allowFromDenyAll: false,
      limits: {
        sendsOutPerMin: 10,
        sendsOutPerHour: 60,
        wakesOutPerHour: 6,
        recvPerHour: 30,
        wakesInPerHour: 12,
        inboxCap: 12,
        pairMinIntervalMs: 30_000,
        pairWakesPerHour: 2,
        inFlightPerSession: 4,
        hubSendsPerMin: 60,
        listPerMin: 6,
      },
      // reply-plan §8.1 (RX0): defaults — feature on, 30min default timeout, 24h ceiling,
      // 8 pending / 3 per target, 10min late grace.
      reply: {
        enabled: true,
        defaultTimeoutS: 1_800,
        maxTimeoutS: 86_400,
        maxPending: 8,
        maxPendingPerTarget: 3,
        lateGraceS: 600,
      },
      // channel-plan §6.4 (CH0): Q6 channels on by default; broadcast wake ceilings are the Q5 hard maxima.
      channels: {
        enabled: true,
        autoJoin: [XS_DEFAULT_CHANNEL],
        autoJoinInvalid: false,
        broadcast: {
          outPerHour: 6,
          minIntervalS: 60,
          wakeOutPerHour: 2,
          maxRecipients: 16,
          wakeMaxRecipients: 4,
        },
      },
      // alias-plan §3.6 (AL0b): Q9 on by default, Q2 7 d lease, Q4 10 min cooling, NQ1 10 min take floor.
      alias: { enabled: true, offlineLeaseH: 168, coolMin: 10, takeMinOfflineMin: 10 },
    },
  },
  cacheTtl: {
    mode: "auto",
    keepalive: true,
    keepaliveIntervalMs: 240_000,
    keepaliveMinPrefixTokens: 20_000,
    childKeepalive: true,
    childKeepaliveMaxPingsPerRun: 24,
    childKeepaliveMaxConcurrent: 4,
    childKeepaliveRunBudgetUsd: 1.5,
    childKeepaliveProcessBudgetUsd: 10,
  },
  quota: {
    enabled: true,
    providers: "zai-coding-cn,zai,kimi-coding,droid",
    subscriptionProviders: "",
    refreshMs: 600_000, // 10min（简报的 refreshMinutes: 10）
    refreshHotMs: 120_000, // 2min（L1/近耗尽 provider）
    staleAfterMs: 3_600_000, // 1h
    l1Percent: 50,
    l2Percent: 75,
    l3Percent: 90,
    l3EtaMs: 1_800_000, // 30min（简报的 ETA < 30min）
    windows: {
      "5h": { l1Percent: 50, l2Percent: 75, l3Percent: 90 },
      week: { l1Percent: 50, l2Percent: 95, l3Percent: 98 },
      month: { l1Percent: 50, l2Percent: 95, l3Percent: 98 },
    },
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
    factoryBaseUrl: "https://api.factory.ai",
    droidAllowExtraUsage: false,
    droidPools: {},
    userAgent: "",
  },
  // Load-aware dispatch (docs/dev/sysload/plan.md §6.1): cpu/mem/disk reuse
  // DEFAULT_LOAD_THRESHOLDS (src/sysload/types.ts) so the frozen §2/§6.1 numbers are written
  // exactly once.
  load: {
    enabled: true,
    gate: true,
    gateLevel: "crit",
    sampleIntervalMs: DEFAULT_LOAD_SAMPLE_INTERVAL_MS,
    sustainMs: DEFAULT_LOAD_SUSTAIN_MS,
    recoverMs: DEFAULT_LOAD_RECOVER_MS,
    cpu: { ...DEFAULT_LOAD_THRESHOLDS.cpu },
    mem: { ...DEFAULT_LOAD_THRESHOLDS.mem },
    disk: { ...DEFAULT_LOAD_THRESHOLDS.disk },
    hint: { enabled: true, display: true, repeatMs: 600_000, minIntervalMs: 120_000 },
    hud: true,
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
    // 默认 10min（2026-10-04 用户调整，原 150s 对真实专家咨询偏紧）。
    timeoutMs: 600_000,
    // 2026-10-18 用户裁定：2000 截断过紧（真实回答被截半），放宽到 6000。
    maxAnswerChars: 6_000,
    maxTurns: 3,
    maxFirstRequestUsd: 2,
    maxCostUsd: 4,
    maxConcurrent: 2,
  },
  hud: { enabled: true, autoFetchMinutes: 5 },
  webHub: {
    enabled: false,
    autoStart: true,
    port: 7878,
    idleExitMinutes: 10,
    nodeLoader: "",
    control: true,
    remoteAskUser: true,
    webCommands: true,
    webCommandPolicy: {},
    // web-hub-steer-recall plan §2/§4.2 / arch §11 Q1: hold busy web steer/followUp until pi's
    // next queue drain so the browser can recall/re-edit them; default ON (user ruling Q1),
    // `false` ⇒ byte-identical rollback (W1/W2).
    steerRecall: true,
    // web-hub-slash-args plan §5 (§11 D1 拍板): / 命令参数提示与补全，默认 all（含第三方命令，
    // 经 TUI autocomplete provider）；non-live（/reload 后 /webhub restart）。
    commandComplete: "all",
    uploads: "on",
    preview: "on",
    avatar: true,
    // web-hub-privacy plan v2.1「设置」(P1): per-session privacy lock; default on, non-live.
    privacy: true,
    subagentTranscript: "all",
    quota: true,
    // sysload plan §6.1/§10 (P0 pre-approved cross-domain field, planning-gap fix): hub-side
    // on/off for its OWN load sampler (`buildHubConfig` writes `config.load` only when BOTH
    // this and `load.enabled` are true, §7.2). Default true.
    load: true,
    lan: DEFAULT_WEBHUB_LAN_SETTINGS,
    spawn: DEFAULT_WEBHUB_SPAWN_SETTINGS,
    // web-hub-proxy plan v2 §5 (X0): off by default, non-live.
    proxy: DEFAULT_WEBHUB_PROXY_SETTINGS,
  },
  webSearch: { enabled: true },
  date: { enabled: true },
  todo: {
    enabled: true,
    nudge: { enabled: true, graceTurns: 2, fallbackTurns: 20, cooldownTurns: 8 },
    archive: { onCompact: true, afterTurns: 30 },
  },
  askUser: {
    enabled: true,
    backgroundInterrupt: {
      enabled: true,
      delayMs: 1_000,
      quietMs: 4_000,
      maxDeferMs: 20_000,
      reaskDwellMs: 10_000,
      maxPerQuestion: 3,
      rpc: false,
    },
  },
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
    layout: "tiered",
    toolSurface: "v2",
    childProfile: "core",
    coreBytes: 1600,
    blockBytes: 2400,
    topicWarnBytes: 8192,
    topicMaxBytes: 16384,
    doctor: { notifyOnStart: true, staleDays: 60 },
    tidy: {
      agentType: "Plan",
      model: "",
      timeoutMs: 180_000,
      maxInputBytes: 49_152,
      maxOutputBytes: 65_536,
      maxCostUsd: 2.0,
      maxTurns: 4,
      batch: { ...DEFAULT_TIDY_BATCH_SETTINGS },
    },
  },
  reload: { defer: true },
  systemPrompt: { wakeReplay: true, mode: "stable", adoptForeignForcedPrompt: false },
  title: {
    enabled: true,
    model: "zai-coding-cn/glm-5.3-flash",
    refreshEveryInputs: 4,
    refreshAfterMinutes: 15,
    refreshWindowMinutes: 60,
    maxRefreshes: 5,
  },
  topicSwitch: { ...DEFAULT_TOPIC_SWITCH_SETTINGS },
  externalAgents: { droid: { ...DEFAULT_EXTERNAL_AGENTS_SETTINGS.droid } },
  feishuBot: { ...DEFAULT_FEISHU_BOT_SETTINGS, files: { ...DEFAULT_FEISHU_BOT_SETTINGS.files } },
  traffic: { ...DEFAULT_TRAFFIC_SETTINGS, web: { ...DEFAULT_TRAFFIC_SETTINGS.web } },
};
/** Parse the optional `agent` settings block (L1). Field-by-field fallback to defaults, never throws. */
export function parseAgentDispatchSettings(input: unknown): AgentDispatchSettings {
  const defaults = DEFAULT_SETTINGS.agent;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const queueWhenFull = (input as Record<string, unknown>).queueWhenFull;
  return { queueWhenFull: typeof queueWhenFull === "boolean" ? queueWhenFull : defaults.queueWhenFull };
}
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
  "consult.timeoutMs",
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
    consult: parseConsultSettings(value.consult),
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
    // totalMs 固定预算：0 会退回默认预算（可宽限/延长），所以下界是 1ms 而不是 0。
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
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ...defaults, wake: { ...defaults.wake }, crossSession: cloneFabricCrossSession(defaults.crossSession) };
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
    wake: parseFabricWakeSettings(value.wake),
    crossSession: parseFabricCrossSessionSettings(value.crossSession),
  };
}

/** Deep-enough clone so a parsed result never aliases `DEFAULT_SETTINGS.fabric.crossSession`. */
function cloneFabricCrossSession(cs: FabricCrossSessionSettings): FabricCrossSessionSettings {
  return {
    ...cs,
    allowFrom: [...cs.allowFrom],
    limits: { ...cs.limits },
    reply: { ...cs.reply },
    channels: { ...cs.channels, autoJoin: [...cs.channels.autoJoin], broadcast: { ...cs.channels.broadcast } },
    alias: { ...cs.alias },
  };
}

/**
 * `fabric.crossSession.alias.*` (alias-plan §3.6, AL0b): field-by-field tolerant, never throws; every numeric
 * leaf clamps into its bounds (`takeMinOfflineMin` can never go below the NQ1 floor of 10).
 */
export function parseFabricXsAliasSettings(input: unknown): FabricXsAliasSettings {
  const defaults = DEFAULT_SETTINGS.fabric.crossSession.alias;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const clamp = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw !== "number" || !Number.isFinite(raw) ? fallback : Math.min(max, Math.max(min, Math.floor(raw)));
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    offlineLeaseH: clamp(
      value.offlineLeaseH,
      defaults.offlineLeaseH,
      FABRIC_XS_ALIAS_OFFLINE_LEASE_H_MIN,
      FABRIC_XS_ALIAS_OFFLINE_LEASE_H_MAX,
    ),
    coolMin: clamp(value.coolMin, defaults.coolMin, FABRIC_XS_ALIAS_COOL_MIN_MIN, FABRIC_XS_ALIAS_COOL_MIN_MAX),
    takeMinOfflineMin: clamp(
      value.takeMinOfflineMin,
      defaults.takeMinOfflineMin,
      FABRIC_XS_ALIAS_TAKE_MIN_OFFLINE_MIN_MIN,
      FABRIC_XS_ALIAS_TAKE_MIN_OFFLINE_MIN_MAX,
    ),
  };
}

/**
 * `fabric.crossSession.channels.*` (channel-plan §6.4, CH0): field-by-field tolerant, never throws;
 * every numeric leaf clamps into its bounds (the two wake leaves can only be tightened, Q5).
 * `autoJoin` entries go through `checkChannelName` (reserved/invalid dropped, de-duplicated, capped at
 * 4); a non-empty array with zero valid entries sets `autoJoinInvalid` and joins nothing.
 */
export function parseFabricXsChannelSettings(input: unknown): FabricXsChannelSettings {
  const defaults = DEFAULT_SETTINGS.fabric.crossSession.channels;
  const clone = (): FabricXsChannelSettings => ({
    ...defaults,
    autoJoin: [...defaults.autoJoin],
    broadcast: { ...defaults.broadcast },
  });
  if (!input || typeof input !== "object" || Array.isArray(input)) return clone();
  const value = input as Record<string, unknown>;
  const clamp = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw !== "number" || !Number.isFinite(raw) ? fallback : Math.min(max, Math.max(min, Math.floor(raw)));
  let autoJoin = [...defaults.autoJoin];
  let autoJoinInvalid = false;
  if (Array.isArray(value.autoJoin)) {
    const names: string[] = [];
    for (const entry of value.autoJoin) {
      const checked = checkChannelName(entry);
      if (checked.ok) names.push(checked.name);
    }
    autoJoin = channelSet(names).slice(0, XS_MAX_CHANNELS);
    autoJoinInvalid = value.autoJoin.length > 0 && autoJoin.length === 0;
    if (autoJoinInvalid) {
      console.warn(
        "[pi-subagent] fabric.crossSession.channels.autoJoin: every entry is invalid or reserved — autoJoin joins nothing",
      );
    }
  }
  const b =
    value.broadcast && typeof value.broadcast === "object" && !Array.isArray(value.broadcast)
      ? (value.broadcast as Record<string, unknown>)
      : {};
  const d = defaults.broadcast;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    autoJoin,
    autoJoinInvalid,
    broadcast: {
      outPerHour: clamp(b.outPerHour, d.outPerHour, 0, FABRIC_XS_BROADCAST_OUT_PER_HOUR_MAX),
      minIntervalS: clamp(
        b.minIntervalS,
        d.minIntervalS,
        FABRIC_XS_BROADCAST_MIN_INTERVAL_MIN_S,
        FABRIC_XS_BROADCAST_MIN_INTERVAL_MAX_S,
      ),
      wakeOutPerHour: clamp(b.wakeOutPerHour, d.wakeOutPerHour, 0, FABRIC_XS_BROADCAST_WAKE_OUT_PER_HOUR_MAX),
      maxRecipients: clamp(
        b.maxRecipients,
        d.maxRecipients,
        FABRIC_XS_BROADCAST_MAX_RECIPIENTS_MIN,
        FABRIC_XS_BROADCAST_MAX_RECIPIENTS_MAX,
      ),
      wakeMaxRecipients: clamp(
        b.wakeMaxRecipients,
        d.wakeMaxRecipients,
        1,
        FABRIC_XS_BROADCAST_WAKE_MAX_RECIPIENTS_MAX,
      ),
    },
  };
}

/**
 * `fabric.crossSession.reply.*` (reply-plan §8.1, RX0): field-by-field tolerant, never throws;
 * every numeric leaf clamps to its bounds (config-accident containment, same posture as the
 * limits block). A non-object block falls back to the defaults.
 */
function parseFabricXsReplySettings(input: unknown): FabricXsReplySettings {
  const defaults = DEFAULT_SETTINGS.fabric.crossSession.reply;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const clamp = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw !== "number" || !Number.isFinite(raw) ? fallback : Math.min(max, Math.max(min, Math.floor(raw)));
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    defaultTimeoutS: clamp(
      value.defaultTimeoutS,
      defaults.defaultTimeoutS,
      FABRIC_XS_REPLY_MIN_TIMEOUT_S,
      FABRIC_XS_REPLY_MAX_TIMEOUT_S,
    ),
    maxTimeoutS: clamp(
      value.maxTimeoutS,
      defaults.maxTimeoutS,
      FABRIC_XS_REPLY_MIN_TIMEOUT_S,
      FABRIC_XS_REPLY_MAX_TIMEOUT_S,
    ),
    maxPending: clamp(
      value.maxPending,
      defaults.maxPending,
      FABRIC_XS_REPLY_MAX_PENDING_MIN,
      FABRIC_XS_REPLY_MAX_PENDING_MAX,
    ),
    maxPendingPerTarget: clamp(
      value.maxPendingPerTarget,
      defaults.maxPendingPerTarget,
      FABRIC_XS_REPLY_MAX_PENDING_PER_TARGET_MIN,
      FABRIC_XS_REPLY_MAX_PENDING_PER_TARGET_MAX,
    ),
    lateGraceS: clamp(
      value.lateGraceS,
      defaults.lateGraceS,
      FABRIC_XS_REPLY_LATE_GRACE_MIN_S,
      FABRIC_XS_REPLY_LATE_GRACE_MAX_S,
    ),
  };
}

/** `fabric.wake.*` (plan v3 §4.8 + phase2 §4.1): field-by-field tolerant, never throws; unknown keys are ignored. */
function parseFabricWakeSettings(input: unknown): FabricWakeSettings {
  const defaults = DEFAULT_SETTINGS.fabric.wake;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const count = (key: Exclude<keyof FabricWakeSettings, "enabled" | "resumeBudgetS" | "rootRunMaxS">): number => {
    const raw = value[key];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : defaults[key];
  };
  const budgetRaw = value.resumeBudgetS;
  const rootRunRaw = value.rootRunMaxS;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    maxLevel: count("maxLevel"),
    perRunQuota: count("perRunQuota"),
    resumeBudgetS:
      typeof budgetRaw === "number" && Number.isFinite(budgetRaw)
        ? Math.min(FABRIC_WAKE_RESUME_BUDGET_MAX_S, Math.max(FABRIC_WAKE_RESUME_BUDGET_MIN_S, Math.floor(budgetRaw)))
        : defaults.resumeBudgetS,
    resumesPerHour: count("resumesPerHour"),
    resumesPerTargetPerHour: count("resumesPerTargetPerHour"),
    parkCapPerTarget: count("parkCapPerTarget"),
    // 0 = Controller off (phase2 §4.5 truth-table row); a positive finite value clamps to 60..3600;
    // anything else (wrong type, NaN, negative) falls back to the default.
    rootRunMaxS:
      rootRunRaw === 0
        ? 0
        : typeof rootRunRaw === "number" && Number.isFinite(rootRunRaw) && rootRunRaw > 0
          ? Math.min(FABRIC_WAKE_ROOT_RUN_MAX_S, Math.max(FABRIC_WAKE_ROOT_RUN_MIN_S, Math.floor(rootRunRaw)))
          : defaults.rootRunMaxS,
  };
}

/**
 * `fabric.crossSession.*` (phase2 §4.1): field-by-field tolerant, never throws. Limits clamp to
 * their §5.2 bounds (config-accident containment, same posture as every other clamped leaf);
 * `allowFrom` entries must be FULL session ids (#14) — invalid ones are dropped with one warn,
 * and a non-empty list with zero valid entries marks `allowFromDenyAll` (deny everything).
 */
export function parseFabricCrossSessionSettings(input: unknown): FabricCrossSessionSettings {
  const defaults = DEFAULT_SETTINGS.fabric.crossSession;
  if (!input || typeof input !== "object" || Array.isArray(input)) return cloneFabricCrossSession(defaults);
  const value = input as Record<string, unknown>;
  // min/max per §5.2; 0 is a legal value exactly where the table says so (wakesOutPerHour,
  // wakesInPerHour, pairWakesPerHour — "0 = deliver-only").
  const clamp = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw !== "number" || !Number.isFinite(raw) ? fallback : Math.min(max, Math.max(min, Math.floor(raw)));
  const rawAllow = value.allowFrom;
  const entries = Array.isArray(rawAllow) ? rawAllow : [];
  const valid: string[] = [];
  let invalid = 0;
  for (const entry of entries) {
    if (typeof entry === "string" && isValidXsSessionId(entry)) valid.push(entry);
    else invalid += 1;
  }
  if (invalid > 0) {
    console.warn(
      `[pi-subagent] fabric.crossSession.allowFrom: dropped ${invalid} invalid ${invalid === 1 ? "entry" : "entries"} (full session ids only)`,
    );
  }
  const reply = parseFabricXsReplySettings(value.reply);
  // reply-plan §8.1 (review #4): `receive:"replies"` is ALWAYS accepted as the stored
  // preference — with the reply feature off its EFFECTIVE value is `off` (effectiveReceive,
  // never a fall-back to the default `wake`). One warn at parse time so the operator sees why.
  const receive: FabricXsReceiveMode =
    value.receive === "off" || value.receive === "deliver" || value.receive === "wake" || value.receive === "replies"
      ? value.receive
      : defaults.receive;
  if (receive === "replies" && !reply.enabled) {
    console.warn(
      '[pi-subagent] fabric.crossSession.receive is "replies" but fabric.crossSession.reply.enabled is false — effective receive is off (not wake)',
    );
  }
  const limitsRaw =
    value.limits && typeof value.limits === "object" && !Array.isArray(value.limits)
      ? (value.limits as Record<string, unknown>)
      : {};
  const limit = (key: keyof FabricCrossSessionLimitsSettings, min: number, max: number): number =>
    clamp(limitsRaw[key], defaults.limits[key], min, max);
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    autoJoin: typeof value.autoJoin === "boolean" ? value.autoJoin : defaults.autoJoin,
    receive,
    allowFrom: valid,
    allowFromDenyAll: !Array.isArray(rawAllow) ? false : entries.length > 0 && valid.length === 0,
    limits: {
      sendsOutPerMin: limit("sendsOutPerMin", 1, 60),
      sendsOutPerHour: limit("sendsOutPerHour", 1, 600),
      wakesOutPerHour: limit("wakesOutPerHour", 0, 60),
      recvPerHour: limit("recvPerHour", 1, 600),
      wakesInPerHour: limit("wakesInPerHour", 0, 60),
      inboxCap: limit("inboxCap", 1, 64),
      pairMinIntervalMs: limit("pairMinIntervalMs", 5_000, 600_000),
      pairWakesPerHour: limit("pairWakesPerHour", 0, 20),
      inFlightPerSession: limit("inFlightPerSession", 1, 16),
      hubSendsPerMin: limit("hubSendsPerMin", 1, 600),
      listPerMin: limit("listPerMin", 1, 60),
    },
    reply,
    channels: parseFabricXsChannelSettings(value.channels),
    alias: parseFabricXsAliasSettings(value.alias),
  };
}

/** Parse the optional Anthropic prompt-cache TTL settings block. Field-by-field tolerant (parseMemorySettings 同款 bool()/num() helpers), never throws. */
export function parseCacheTtlSettings(input: unknown): CacheTtlSettings {
  const defaults = DEFAULT_SETTINGS.cacheTtl;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const bool = (raw: unknown, fallback: boolean): boolean => (typeof raw === "boolean" ? raw : fallback);
  const num = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? Math.floor(raw) : fallback;
  // USD 变体：不取整——0.5 的预算被 floor 成 0 会把「半美元」误读成「关闭」，方向不可接受。
  const usd = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
  const mode = value.mode;
  const parsedMode = mode === "auto" || mode === "on" || mode === "off" ? mode : defaults.mode;
  if (mode === "adaptive") console.warn('[pi-subagent] cacheTtl mode "adaptive" was removed; using auto');
  return {
    mode: parsedMode,
    keepalive: bool(value.keepalive, defaults.keepalive),
    keepaliveIntervalMs: num(
      value.keepaliveIntervalMs,
      defaults.keepaliveIntervalMs,
      60_000,
      MAX_SAFE_KEEPALIVE_INTERVAL_MS,
    ),
    ...(Object.prototype.hasOwnProperty.call(value, "keepaliveMaxPings")
      ? {
          legacyKeepaliveMaxPings:
            typeof value.keepaliveMaxPings === "number" && Number.isFinite(value.keepaliveMaxPings)
              ? value.keepaliveMaxPings
              : ("invalid" as const),
        }
      : {}),
    keepaliveMinPrefixTokens: num(
      value.keepaliveMinPrefixTokens,
      defaults.keepaliveMinPrefixTokens,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    childKeepalive: bool(value.childKeepalive, defaults.childKeepalive),
    childKeepaliveMaxPingsPerRun: num(
      value.childKeepaliveMaxPingsPerRun,
      defaults.childKeepaliveMaxPingsPerRun,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    childKeepaliveMaxConcurrent: num(value.childKeepaliveMaxConcurrent, defaults.childKeepaliveMaxConcurrent, 1, 32),
    childKeepaliveRunBudgetUsd: usd(value.childKeepaliveRunBudgetUsd, defaults.childKeepaliveRunBudgetUsd, 0, 1000),
    childKeepaliveProcessBudgetUsd: usd(
      value.childKeepaliveProcessBudgetUsd,
      defaults.childKeepaliveProcessBudgetUsd,
      0,
      10_000,
    ),
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
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ...defaults, windows: { ...defaults.windows } };
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
  const isValidPercent = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 100;
  const windows = parseQuotaWindowThresholds(value.windows, defaults.windows, {
    l1: isValidPercent(value.l1Percent) ? l1 : undefined,
    l2: isValidPercent(value.l2Percent) ? l2 : undefined,
    l3: isValidPercent(value.l3Percent) ? l3 : undefined,
  });
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
    windows,
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
    factoryBaseUrl: url(value.factoryBaseUrl, defaults.factoryBaseUrl),
    droidAllowExtraUsage: bool(value.droidAllowExtraUsage, defaults.droidAllowExtraUsage),
    droidPools: parseDroidPools(value.droidPools),
    userAgent: str(value.userAgent, defaults.userAgent),
  };
}

/** droid 模型 id 键形（plan §2.7：≤128 字符的模型 id 字符集）。 */
const DROID_POOL_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
/** `quota.droidPools` 解析（plan §2.7）：非对象 ⇒ {}；非法键/非法值逐条丢弃；≤200 条。永不抛。 */
function parseDroidPools(raw: unknown): Readonly<Record<string, QuotaPoolId | "none">> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, QuotaPoolId | "none"> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= 200) break;
    if (!DROID_POOL_KEY.test(key)) continue;
    if (value !== "standard" && value !== "core" && value !== "none") continue;
    out[key] = value;
  }
  return out;
}

/**
 * 单个窗口的阈值解析（quota-plan「阶梯阈值按窗口区分」）：优先级 窗口级字段 >
 * 显式设置的全局旧字段（`globalOverride`，未设置则为 undefined）> 按窗口仓库
 * 默认。窗口内部再次钳制 l1<=l2<=l3（与旧的全局钳制同款，配置写反顶上去而非
 * 静默失效）。
 */
function parseWindowThresholds(
  raw: unknown,
  scopeDefaults: QuotaWindowThresholds,
  globalOverride: { readonly l1: number | undefined; readonly l2: number | undefined; readonly l3: number | undefined },
): QuotaWindowThresholds {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 100 ? Math.floor(value) : fallback;
  const base1 = globalOverride.l1 ?? scopeDefaults.l1Percent;
  const base2 = globalOverride.l2 ?? scopeDefaults.l2Percent;
  const base3 = globalOverride.l3 ?? scopeDefaults.l3Percent;
  const l1 = num(record?.l1Percent, base1);
  const l2 = Math.max(l1, num(record?.l2Percent, base2));
  const l3 = Math.max(l2, num(record?.l3Percent, base3));
  return { l1Percent: l1, l2Percent: l2, l3Percent: l3 };
}

/** `quota.windows` 块解析：非对象/缺失 → 对所有窗口都应用 globalOverride 后的默认。 */
function parseQuotaWindowThresholds(
  raw: unknown,
  defaults: Readonly<Record<WindowScope, QuotaWindowThresholds>>,
  globalOverride: { readonly l1: number | undefined; readonly l2: number | undefined; readonly l3: number | undefined },
): Readonly<Record<WindowScope, QuotaWindowThresholds>> {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  return {
    "5h": parseWindowThresholds(record?.["5h"], defaults["5h"], globalOverride),
    week: parseWindowThresholds(record?.week, defaults.week, globalOverride),
    month: parseWindowThresholds(record?.month, defaults.month, globalOverride),
  };
}

/**
 * sysload plan §6.1: `load.*` settings block. Field-by-field tolerant, never throws (same
 * hand-written style as `parseQuotaSettings`). Interval/sustain/recover are clamped INTO range
 * (never fallback-to-default-on-out-of-range) so the §5.2 invariant `interval ≤ recover ≤
 * 120×interval` and `0 ≤ sustain ≤ 120×interval` always holds for the RETURNED value, even when
 * the caller only overrides `sampleIntervalMs` and leaves `sustainMs`/`recoverMs` at their
 * (now out-of-range) defaults — clamping the fallback itself, not just explicit input, is what
 * keeps that true unconditionally (§5.2 "parse 越界即钒").
 * Accepted semantics: out-of-range values clamp to bounds, inverted warn/crit pairs clamp monotonically,
 * and `recoverMs` is always at least `sampleIntervalMs`.
 */
export function parseLoadSettings(input: unknown): LoadSettings {
  const defaults = DEFAULT_SETTINGS.load;
  if (!input || typeof input !== "object" || Array.isArray(input))
    return {
      ...defaults,
      cpu: { ...defaults.cpu },
      mem: { ...defaults.mem },
      disk: { ...defaults.disk },
      hint: { ...defaults.hint },
    };
  const value = input as Record<string, unknown>;
  const bool = (raw: unknown, fallback: boolean): boolean => (typeof raw === "boolean" ? raw : fallback);
  // Clamps BOTH explicit input and the fallback into [min,max] — never returns an out-of-range
  // value even when the explicit input is garbage and the (int-derived) bounds moved since the
  // literal default was chosen (see interval-dependent sustain/recover above).
  const clampInt = (raw: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : fallback;
    return Math.min(max, Math.max(min, n));
  };
  const percent = (raw: unknown, fallback: number): number => clampInt(raw, fallback, 0, 100);

  const sampleIntervalMs = clampInt(
    value.sampleIntervalMs,
    defaults.sampleIntervalMs,
    LOAD_SAMPLE_INTERVAL_MIN_MS,
    LOAD_SAMPLE_INTERVAL_MAX_MS,
  );
  const sustainMaxMs = LOAD_SUSTAIN_RECOVER_MAX_FACTOR * sampleIntervalMs;
  const sustainMs = clampInt(value.sustainMs, defaults.sustainMs, 0, sustainMaxMs);
  const recoverMs = clampInt(value.recoverMs, defaults.recoverMs, sampleIntervalMs, sustainMaxMs);

  const cpuRecord =
    value.cpu && typeof value.cpu === "object" && !Array.isArray(value.cpu)
      ? (value.cpu as Record<string, unknown>)
      : undefined;
  // CPU: warn <= crit (higher busy/PSI is worse), same max()-chain style as quota's l1<=l2<=l3.
  const cpuWarnPercent = percent(cpuRecord?.warnPercent, defaults.cpu.warnPercent);
  const cpuCritPercent = Math.max(cpuWarnPercent, percent(cpuRecord?.critPercent, defaults.cpu.critPercent));
  const cpuPsiWarnPercent = percent(cpuRecord?.psiWarnPercent, defaults.cpu.psiWarnPercent);
  const cpuPsiCritPercent = Math.max(
    cpuPsiWarnPercent,
    percent(cpuRecord?.psiCritPercent, defaults.cpu.psiCritPercent),
  );

  const memRecord =
    value.mem && typeof value.mem === "object" && !Array.isArray(value.mem)
      ? (value.mem as Record<string, unknown>)
      : undefined;
  // MEM: warn >= crit (a LOWER available% is worse) — crit is clamped DOWN to warn, mirror image
  // of the CPU chain above.
  const memWarnAvailPercent = percent(memRecord?.warnAvailPercent, defaults.mem.warnAvailPercent);
  const memCritAvailPercent = Math.min(
    memWarnAvailPercent,
    percent(memRecord?.critAvailPercent, defaults.mem.critAvailPercent),
  );

  const diskRecord =
    value.disk && typeof value.disk === "object" && !Array.isArray(value.disk)
      ? (value.disk as Record<string, unknown>)
      : undefined;
  // DISK: warn >= crit (a LOWER free% is worse), same mirror-image chain as MEM.
  const diskWarnFreePercent = percent(diskRecord?.warnFreePercent, defaults.disk.warnFreePercent);
  const diskCritFreePercent = Math.min(
    diskWarnFreePercent,
    percent(diskRecord?.critFreePercent, defaults.disk.critFreePercent),
  );
  const diskCritFreeGiB = clampInt(diskRecord?.critFreeGiB, defaults.disk.critFreeGiB, 0, 1_000_000);

  const hintRecord =
    value.hint && typeof value.hint === "object" && !Array.isArray(value.hint)
      ? (value.hint as Record<string, unknown>)
      : undefined;

  return {
    enabled: bool(value.enabled, defaults.enabled),
    gate: bool(value.gate, defaults.gate),
    gateLevel: value.gateLevel === "warn" || value.gateLevel === "crit" ? value.gateLevel : defaults.gateLevel,
    sampleIntervalMs,
    sustainMs,
    recoverMs,
    cpu: {
      warnPercent: cpuWarnPercent,
      critPercent: cpuCritPercent,
      psiWarnPercent: cpuPsiWarnPercent,
      psiCritPercent: cpuPsiCritPercent,
    },
    mem: { warnAvailPercent: memWarnAvailPercent, critAvailPercent: memCritAvailPercent },
    disk: {
      warnFreePercent: diskWarnFreePercent,
      critFreePercent: diskCritFreePercent,
      critFreeGiB: diskCritFreeGiB,
    },
    hint: {
      enabled: bool(hintRecord?.enabled, defaults.hint.enabled),
      display: bool(hintRecord?.display, defaults.hint.display),
      repeatMs: clampInt(hintRecord?.repeatMs, defaults.hint.repeatMs, 0, 86_400_000),
      minIntervalMs: clampInt(hintRecord?.minIntervalMs, defaults.hint.minIntervalMs, 0, 86_400_000),
    },
    hud: bool(value.hud, defaults.hud),
  };
}

/** Parse an `{enabled}` on/off group (merged plugins); field-level fallback to defaults, never throws. */
function parseEnabledGroup(input: unknown, defaults: EnabledGroup): EnabledGroup {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const enabled = (input as Record<string, unknown>).enabled;
  return { enabled: typeof enabled === "boolean" ? enabled : defaults.enabled };
}

/**
 * Parse the `askUser` settings block (ask-user-async plan §6.1, P2):
 * EnabledGroup semantics plus the `backgroundInterrupt` sub-block,
 * field-by-field fallback to DEFAULT_SETTINGS.askUser, never throws
 * (parseTodoSettings 同款). The four durations arrive ALREADY in internal
 * milliseconds (normalizeTimeUnits converts the on-disk integer `*S` seconds
 * up front); each must be a finite integer inside its §5.2.1 range, and
 * `maxDeferMs < quietMs` clamps UP to quietMs.
 */
function parseAskUserSettings(input: unknown): AskUserSettings {
  const defaults = DEFAULT_SETTINGS.askUser;
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ...defaults, backgroundInterrupt: { ...defaults.backgroundInterrupt } };
  const record = input as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    backgroundInterrupt: parseBackgroundInterruptSettings(record.backgroundInterrupt, defaults.backgroundInterrupt),
  };
}

function parseBackgroundInterruptSettings(
  input: unknown,
  defaults: AskUserBackgroundInterruptSettings,
): AskUserBackgroundInterruptSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const record = input as Record<string, unknown>;
  const rangedMs = (value: unknown, fallback: number, max: number): number =>
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= max
      ? value
      : fallback;
  const quietMs = rangedMs(record.quietMs, defaults.quietMs, 30_000);
  const maxDeferMs = rangedMs(record.maxDeferMs, defaults.maxDeferMs, 120_000);
  const maxPerQuestion = record.maxPerQuestion;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    delayMs: rangedMs(record.delayMs, defaults.delayMs, 10_000),
    quietMs,
    // §5.2.1：≥ quiet（否则钳为 quiet）；但显式 0 保留——0 是「永不因活跃推迟」
    // 的特殊语义（interrupt.ts normalizeInterruptSettings 同款规则，2026-10-05 验收
    // 发现此处无条件钳制会把 maxDeferS:0 错成 quietS 默认值）。
    maxDeferMs: maxDeferMs === 0 ? 0 : Math.max(maxDeferMs, quietMs),
    reaskDwellMs: rangedMs(record.reaskDwellMs, defaults.reaskDwellMs, 60_000),
    maxPerQuestion:
      typeof maxPerQuestion === "number" &&
      Number.isFinite(maxPerQuestion) &&
      Number.isInteger(maxPerQuestion) &&
      maxPerQuestion >= 1 &&
      maxPerQuestion <= 10
        ? maxPerQuestion
        : defaults.maxPerQuestion,
    rpc: typeof record.rpc === "boolean" ? record.rpc : defaults.rpc,
  };
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
 * Parse the `todo` settings block: `enabled` is the existing EnabledGroup
 * semantics, `nudge` is a nested sub-block (todo-nudge plan) that falls back
 * field-by-field to DEFAULT_SETTINGS.todo.nudge — all four fields are plain
 * turn counts (not durations), positive integers required, illegal/missing
 * values fall back individually; never throws.
 */
function parseTodoSettings(input: unknown): TodoSettings {
  const defaults = DEFAULT_SETTINGS.todo;
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ...defaults, nudge: { ...defaults.nudge }, archive: { ...defaults.archive } };
  const record = input as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    nudge: parseTodoNudgeSettings(record.nudge, defaults.nudge),
    archive: parseTodoArchiveSettings(record.archive, defaults.archive),
  };
}

/** todo-archive plan §2: field-by-field fallback to DEFAULT_SETTINGS.todo.archive; `afterTurns`
 * accepts integers >= 0 (0 = off); never throws. */
function parseTodoArchiveSettings(input: unknown, defaults: TodoArchiveSettings): TodoArchiveSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const record = input as Record<string, unknown>;
  const afterTurns = record.afterTurns;
  return {
    onCompact: typeof record.onCompact === "boolean" ? record.onCompact : defaults.onCompact,
    afterTurns:
      typeof afterTurns === "number" && Number.isFinite(afterTurns) && Number.isInteger(afterTurns) && afterTurns >= 0
        ? afterTurns
        : defaults.afterTurns,
  };
}

function parseTodoNudgeSettings(input: unknown, defaults: TodoNudgeSettings): TodoNudgeSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const record = input as Record<string, unknown>;
  const positiveInt = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : fallback;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    graceTurns: positiveInt(record.graceTurns, defaults.graceTurns),
    fallbackTurns: positiveInt(record.fallbackTurns, defaults.fallbackTurns),
    cooldownTurns: positiveInt(record.cooldownTurns, defaults.cooldownTurns),
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
  const numFloat = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
  const choice = <T extends string>(raw: unknown, values: readonly T[], fallback: T): T =>
    typeof raw === "string" && (values as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const maxFileBytes = num(value.maxFileBytes, defaults.maxFileBytes, 1024, 4 * 1024 * 1024);

  const blockBytes = num(value.blockBytes, defaults.blockBytes, 800, 16384);
  const coreBytes = Math.min(num(value.coreBytes, defaults.coreBytes, 256, 8192), Math.max(0, blockBytes - 600));
  const topicWarnBytes = num(value.topicWarnBytes, defaults.topicWarnBytes, 1024, maxFileBytes);
  const topicMaxBytes = Math.max(
    num(value.topicMaxBytes, defaults.topicMaxBytes, topicWarnBytes, maxFileBytes),
    topicWarnBytes,
  );

  const doctorRaw = value.doctor;
  const doctorObj: Record<string, unknown> =
    doctorRaw && typeof doctorRaw === "object" && !Array.isArray(doctorRaw)
      ? (doctorRaw as Record<string, unknown>)
      : {};
  const doctor: MemoryDoctorSettings = {
    notifyOnStart: bool(doctorObj.notifyOnStart, defaults.doctor.notifyOnStart),
    staleDays: num(doctorObj.staleDays, defaults.doctor.staleDays, 7, 3650),
  };

  const tidyRaw = value.tidy;
  const tidyObj: Record<string, unknown> =
    tidyRaw && typeof tidyRaw === "object" && !Array.isArray(tidyRaw) ? (tidyRaw as Record<string, unknown>) : {};
  const maxInputBytes = num(tidyObj.maxInputBytes, defaults.tidy.maxInputBytes, 8192, 262_144);
  const tidy: MemoryTidySettings = {
    agentType:
      typeof tidyObj.agentType === "string" && tidyObj.agentType.trim() !== ""
        ? tidyObj.agentType
        : defaults.tidy.agentType,
    model: typeof tidyObj.model === "string" ? tidyObj.model : defaults.tidy.model,
    timeoutMs: num(tidyObj.timeoutMs, defaults.tidy.timeoutMs, 30_000, 1_800_000),
    maxInputBytes,
    maxOutputBytes: num(tidyObj.maxOutputBytes, defaults.tidy.maxOutputBytes, 4096, 262_144),
    maxCostUsd: numFloat(tidyObj.maxCostUsd, defaults.tidy.maxCostUsd, 0.05, 50),
    maxTurns: num(tidyObj.maxTurns, defaults.tidy.maxTurns, 1, 20),
    batch: resolveTidyBatchSettings(tidyObj.batch, maxInputBytes),
  };

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
    layout: choice<MemoryLayout>(value.layout, ["tiered", "legacy"], defaults.layout),
    toolSurface: choice<MemoryToolSurface>(value.toolSurface, ["v2", "legacy"], defaults.toolSurface),
    childProfile: choice<ChildProfile>(value.childProfile, ["core", "full", "none"], defaults.childProfile),
    coreBytes,
    blockBytes,
    topicWarnBytes,
    topicMaxBytes,
    doctor,
    tidy,
  };
}

/**
 * web-hub settings block (plan 包 I): field-level fallback to defaults, never
 * throws (parseHudSettings 同款). `port` must be an integer in 0..65535 (0 =
 * ephemeral); `idleExitMinutes` must be finite and ≥ 1.
 *
 * `webHub.lan.*` (plan §9.1, S1-W3 LI): parsed by `parseWebHubLanBlock` below — same helper used
 * by `parseWebHubLanValidation` (exported for status-line consumers, e.g. `/webhub status`) so the
 * accepted/rejected classification of every host token never drifts between the two call sites.
 */
function resolveWebHubPort(record: Record<string, unknown>): number {
  const defaults = DEFAULT_SETTINGS.webHub;
  const port = record.port;
  return typeof port === "number" && Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : defaults.port;
}

export function parseWebHubSettings(input: unknown): WebHubSettings {
  const defaults = DEFAULT_SETTINGS.webHub;
  if (!input || typeof input !== "object" || Array.isArray(input))
    return {
      ...defaults,
      lan: { ...defaults.lan! },
      spawn: parseWebHubSpawnBlock(undefined),
      proxy: { ...DEFAULT_WEBHUB_PROXY_SETTINGS },
    };
  const record = input as Record<string, unknown>;
  const idle = record.idleExitMinutes;
  const nodeLoader = record.nodeLoader;
  const resolvedPort = resolveWebHubPort(record);
  const lanParsed = parseWebHubLanBlock(record.lan, resolvedPort);
  const policy: Record<string, "allow" | "confirm" | "deny"> = {};
  let rawPolicy: unknown = record.webCommandPolicy;
  if (typeof rawPolicy === "string") {
    try {
      rawPolicy = JSON.parse(rawPolicy);
    } catch {
      rawPolicy = undefined;
    }
  }
  if (rawPolicy !== null && typeof rawPolicy === "object" && !Array.isArray(rawPolicy)) {
    for (const [key, value] of Object.entries(rawPolicy as Record<string, unknown>)) {
      if (
        /^[A-Za-z0-9:_.-]{1,64}(?: [A-Za-z0-9:_.-]{1,64})?$/.test(key) &&
        (value === "allow" || value === "confirm" || value === "deny")
      )
        policy[key] = value;
    }
  }
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    autoStart: typeof record.autoStart === "boolean" ? record.autoStart : defaults.autoStart,
    port: resolvedPort,
    idleExitMinutes: typeof idle === "number" && Number.isFinite(idle) && idle >= 1 ? idle : defaults.idleExitMinutes,
    nodeLoader: typeof nodeLoader === "string" ? nodeLoader : defaults.nodeLoader,
    control: typeof record.control === "boolean" ? record.control : (defaults.control ?? true),
    remoteAskUser: typeof record.remoteAskUser === "boolean" ? record.remoteAskUser : (defaults.remoteAskUser ?? true),
    webCommands: typeof record.webCommands === "boolean" ? record.webCommands : (defaults.webCommands ?? true),
    webCommandPolicy: policy,
    // web-hub-steer-recall plan §4.2: boolean only, anything else falls back to the default
    // `true` (arch §11 Q1) — never throws.
    steerRecall: typeof record.steerRecall === "boolean" ? record.steerRecall : (defaults.steerRecall ?? true),
    // web-hub-slash-args plan §5 (P0): tri-valued, any other value falls back to "all" (§11 D1 拍板).
    commandComplete: parseCommandCompleteSetting(record.commandComplete, defaults.commandComplete),
    uploads: parseUploadsSetting(record.uploads, defaults.uploads),
    preview: parsePreviewSetting(record.preview, defaults.preview),
    avatar: typeof record.avatar === "boolean" ? record.avatar : (defaults.avatar ?? true),
    // web-hub-privacy plan v2.1 (P1): boolean only, anything else falls back to the default `true`.
    privacy: typeof record.privacy === "boolean" ? record.privacy : (defaults.privacy ?? true),
    subagentTranscript: parseSubagentTranscriptSetting(record.subagentTranscript, defaults.subagentTranscript),
    quota: typeof record.quota === "boolean" ? record.quota : (defaults.quota ?? true),
    // sysload plan §6.1: boolean only, anything else falls back to the default `true`.
    load: typeof record.load === "boolean" ? record.load : (defaults.load ?? true),
    lan: lanParsed.lan,
    spawn: parseWebHubSpawnBlock(record.spawn),
    proxy: parseWebHubProxyBlock(record.proxy, resolvedPort, lanParsed.lan.port).proxy,
  };
}

/** web-hub-upload plan §6 U1: `webHub.uploads` is tri-valued; any other value falls back to "on". */
function parseUploadsSetting(raw: unknown, fallback: "on" | "loopback" | "off" | undefined): "on" | "loopback" | "off" {
  if (raw === "on" || raw === "loopback" || raw === "off") return raw;
  return fallback ?? "on";
}

/** web-hub-preview plan v3 §4.1/U1 (PV1): `webHub.preview` is tri-valued like `webHub.uploads`;
 * any other value falls back to the default "on" (U1). */
function parsePreviewSetting(raw: unknown, fallback: "on" | "loopback" | "off" | undefined): "on" | "loopback" | "off" {
  if (raw === "on" || raw === "loopback" || raw === "off") return raw;
  return fallback ?? "on";
}

/** web-hub-fleet-drawer plan §4.4 (F2): `webHub.subagentTranscript` is tri-valued;
 * any other value falls back to the default "all"（用户已拍板）. */
function parseSubagentTranscriptSetting(
  raw: unknown,
  fallback: "all" | "loopback" | "off" | undefined,
): "all" | "loopback" | "off" {
  if (raw === "all" || raw === "loopback" || raw === "off") return raw;
  return fallback ?? "all";
}

/** web-hub-slash-args plan §5 (P0): `webHub.commandComplete` is tri-valued like
 * `webHub.subagentTranscript`; any other value falls back to the default "all" (§11 D1
 * 拍板 — includes third-party commands via the TUI provider). Non-live like the rest of
 * webHub.*: change → /reload then /webhub restart. */
function parseCommandCompleteSetting(
  raw: unknown,
  fallback: "all" | "toolkit" | "off" | undefined,
): "all" | "toolkit" | "off" {
  if (raw === "all" || raw === "toolkit" || raw === "off") return raw;
  return fallback ?? "all";
}

/**
 * `webHub.spawn` 块解析（web-hub-spawn plan §SP2 / arch v2 §6.2；parseWebHubLanBlock 同款容错，
 * never throws）：`roots` 复用 `splitLanCsv`（CSV 字符串或 JSON 数组皆可，与 lan 三键同源）；
 * 数值按 arch §6.2 范围取整钳制，非法（非有限数）回落默认；`lan` 三选一。hub 侧
 * `hub/spawn/config.ts` 的 `parseHubSpawnConfig` 会再做一次严格重校验。
 */
export function parseWebHubSpawnBlock(input: unknown): WebHubSpawnSettings {
  const defaults = DEFAULT_WEBHUB_SPAWN_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...defaults, roots: [] };
  }
  const record = input as Record<string, unknown>;
  // arch §6.2: 每项 `/` 或 `~` 开头、无 NUL、≤4096 UTF-8 字节；非法项静静丢弃；最多 16 项。
  const roots = splitLanCsv(record.roots)
    .filter(
      (entry) =>
        (entry.startsWith("/") || entry.startsWith("~")) && !entry.includes("\0") && Buffer.byteLength(entry) <= 4096,
    )
    .slice(0, 16);
  const lan = record.lan;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    roots,
    maxProcesses: clampSpawnInt(record.maxProcesses, 1, 16, defaults.maxProcesses),
    maxPerPrincipal: clampSpawnInt(record.maxPerPrincipal, 1, 16, defaults.maxPerPrincipal),
    ratePerMinute: clampSpawnInt(record.ratePerMinute, 1, 30, defaults.ratePerMinute),
    maxLifetimeMinutes: clampSpawnInt(record.maxLifetimeMinutes, 10, 10_080, defaults.maxLifetimeMinutes),
    registerTimeoutS: clampSpawnInt(record.registerTimeoutS, 10, 120, defaults.registerTimeoutS),
    lan: lan === "off" || lan === "known" || lan === "roots" ? lan : defaults.lan,
    restore: typeof record.restore === "boolean" ? record.restore : defaults.restore,
    history: typeof record.history === "boolean" ? record.history : defaults.history,
    lanConfirm: typeof record.lanConfirm === "boolean" ? record.lanConfirm : defaults.lanConfirm,
  };
}

/** `parseWebHubProxyBlock` warning codes (web-hub-proxy plan v2 §5 "default + warning"). */
export type WebHubProxyWarning = "port-range-invalid" | "port-range-overlap" | "max-proxies-invalid";

export interface WebHubProxyParseResult {
  proxy: WebHubProxySettings;
  /** Every field that fell back to its default, for status-line consumers (`/webhub status`). */
  warnings: WebHubProxyWarning[];
}

/**
 * `webHub.proxy` block parse (web-hub-proxy plan v2 §5; `parseWebHubLanBlock` style — never
 * throws, field-by-field fallback, pure so repeated calls never spam logs; warnings are RETURNED):
 * - `enabled`: a real boolean, else `false`;
 * - `portRange`: `"<lo>-<hi>"` (decimal, no leading zero, lo ≤ hi, ports 1024..65535, span ≤ 256)
 *   that overlaps neither the resolved hub port nor the LAN port ⇒ stored canonically; anything
 *   else ⇒ the default range + a warning. `webHubPort` 0 (ephemeral) never overlaps — the real
 *   bound port is the engine's runtime `self-port` rule. If the DEFAULT range itself overlaps,
 *   the hub's second-line check (X1c) is the veto, same as `lan.port`'s default collision;
 * - `maxProxies`: an integer in 1..16, else 8 + a warning.
 * The range grammar is a parity copy of `protocol/proxy.ts`'s `parseProxyPortRange` (see
 * `DEFAULT_WEBHUB_PROXY_SETTINGS`' note); `tests/web-hub/protocol/proxy.test.ts` pins parity.
 */
export function parseWebHubProxyBlock(input: unknown, webHubPort: number, lanPort: number): WebHubProxyParseResult {
  const defaults = DEFAULT_WEBHUB_PROXY_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { proxy: { ...defaults }, warnings: [] };
  }
  const record = input as Record<string, unknown>;
  const warnings: WebHubProxyWarning[] = [];

  let portRange = defaults.portRange;
  if (record.portRange !== undefined) {
    const range = parseProxyPortRangeText(record.portRange);
    if (range === undefined) {
      warnings.push("port-range-invalid");
    } else if ([webHubPort, lanPort].some((port) => port > 0 && port >= range[0] && port <= range[1])) {
      warnings.push("port-range-overlap");
    } else {
      portRange = `${String(range[0])}-${String(range[1])}`;
    }
  }

  let maxProxies = defaults.maxProxies;
  if (record.maxProxies !== undefined) {
    const raw = record.maxProxies;
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 16) maxProxies = raw;
    else warnings.push("max-proxies-invalid");
  }

  return {
    proxy: {
      enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
      portRange,
      maxProxies,
    },
    warnings,
  };
}

/** Parity copy of `protocol/proxy.ts`'s `parseProxyPortRange` (see `parseWebHubProxyBlock`). */
function parseProxyPortRangeText(text: unknown): [number, number] | undefined {
  if (typeof text !== "string") return undefined;
  const m = /^([1-9]\d{0,4})-([1-9]\d{0,4})$/.exec(text.trim());
  if (m === null) return undefined;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (lo > hi || lo < 1024 || hi > 65_535 || hi - lo + 1 > 256) return undefined;
  return [lo, hi];
}

/** `parseFeishuBotBlock` warning codes: one per leaf that fell back (`-invalid`) or was clamped (`-clamped`). */
export type FeishuBotWarning =
  | "block-invalid"
  | "enabled-invalid"
  | "security-alerts-invalid"
  | "xs-mirror-invalid"
  | "allow-groups-invalid"
  | "group-root-topics-invalid"
  | "notify-invalid"
  | "spawn-scope-invalid"
  | "debounce-invalid"
  | "debounce-clamped"
  | "stale-invalid"
  | "stale-clamped"
  | "files-invalid"
  | "files-outbound-invalid"
  | "files-inbound-invalid"
  | "files-max-inbound-invalid"
  | "files-max-inbound-clamped";

export interface FeishuBotParseResult {
  feishuBot: FeishuBotSettings;
  /** Every leaf that fell back to its default or was clamped, for `/webhub feishu status` (returned, never logged). */
  warnings: FeishuBotWarning[];
}

/**
 * Top-level `feishuBot` block parse (feishu-bot plan v2 §9; `parseWebHubProxyBlock` style — never
 * throws, field-by-field, pure so repeated calls never spam logs; warnings are RETURNED):
 * - booleans / enums (`notify` bound|off, `spawnScope` known|roots, `files.outbound` auto|buttons|off):
 *   a wrong type or unknown value ⇒ the default + `<leaf>-invalid`;
 * - numbers (`debounceMs` 0–10 000, `staleMessageS` 30–3 600, `files.maxInboundMiB` 1–100): a non-finite or
 *   non-number ⇒ default + `-invalid`; a finite number is rounded then CLAMPED into range (+ `-clamped`
 *   when it changed) — the hub-side normalizer then only ever sees in-range values;
 * - a non-object block ⇒ all defaults (+ `block-invalid` when it is present but not an object).
 * Literal mirror of `protocol/feishu.ts`'s ranges (see `DEFAULT_FEISHU_BOT_SETTINGS`' note).
 */
export function parseFeishuBotBlock(input: unknown): FeishuBotParseResult {
  const d = DEFAULT_FEISHU_BOT_SETTINGS;
  const defaults = (): FeishuBotSettings => ({ ...d, files: { ...d.files } });
  if (input === undefined || input === null) return { feishuBot: defaults(), warnings: [] };
  if (typeof input !== "object" || Array.isArray(input)) return { feishuBot: defaults(), warnings: ["block-invalid"] };
  const r = input as Record<string, unknown>;
  const warnings: FeishuBotWarning[] = [];

  const bool = (raw: unknown, fallback: boolean, code: FeishuBotWarning): boolean => {
    if (raw === undefined) return fallback;
    if (typeof raw === "boolean") return raw;
    warnings.push(code);
    return fallback;
  };
  const choice = <T extends string>(raw: unknown, allowed: readonly T[], fallback: T, code: FeishuBotWarning): T => {
    if (raw === undefined) return fallback;
    if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) return raw as T;
    warnings.push(code);
    return fallback;
  };
  const num = (
    raw: unknown,
    min: number,
    max: number,
    fallback: number,
    invalid: FeishuBotWarning,
    clamped: FeishuBotWarning,
  ): number => {
    if (raw === undefined) return fallback;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      warnings.push(invalid);
      return fallback;
    }
    const rounded = Math.round(raw);
    const bounded = Math.min(max, Math.max(min, rounded));
    if (bounded !== raw) warnings.push(clamped);
    return bounded;
  };

  const filesRaw = r.files;
  let filesRecord: Record<string, unknown> = {};
  if (filesRaw !== undefined) {
    if (filesRaw !== null && typeof filesRaw === "object" && !Array.isArray(filesRaw)) {
      filesRecord = filesRaw as Record<string, unknown>;
    } else {
      warnings.push("files-invalid");
    }
  }

  return {
    feishuBot: {
      enabled: bool(r.enabled, d.enabled, "enabled-invalid"),
      securityAlerts: bool(r.securityAlerts, d.securityAlerts ?? true, "security-alerts-invalid"),
      xsMirror: bool(r.xsMirror, d.xsMirror ?? true, "xs-mirror-invalid"),
      allowGroups: bool(r.allowGroups, d.allowGroups, "allow-groups-invalid"),
      groupRootTopics: bool(r.groupRootTopics, d.groupRootTopics, "group-root-topics-invalid"),
      notify: choice(r.notify, ["bound", "off"] as const, d.notify, "notify-invalid"),
      spawnScope: choice(r.spawnScope, ["known", "roots"] as const, d.spawnScope, "spawn-scope-invalid"),
      debounceMs: num(r.debounceMs, 0, 10_000, d.debounceMs, "debounce-invalid", "debounce-clamped"),
      staleMessageS: num(r.staleMessageS, 30, 3_600, d.staleMessageS, "stale-invalid", "stale-clamped"),
      files: {
        outbound: choice(
          filesRecord.outbound,
          ["auto", "buttons", "off"] as const,
          d.files.outbound,
          "files-outbound-invalid",
        ),
        inbound: bool(filesRecord.inbound, d.files.inbound, "files-inbound-invalid"),
        maxInboundMiB: num(
          filesRecord.maxInboundMiB,
          1,
          100,
          d.files.maxInboundMiB,
          "files-max-inbound-invalid",
          "files-max-inbound-clamped",
        ),
      },
    },
    warnings,
  };
}

/** arch §6.2 数值域的容错读取：有限数 ⇒ 取整后钳进 [min,max]；其余（字符串/NaN/Infinity/缺失）回落默认。 */
function clampSpawnInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

/**
 * List-valued LAN settings accept either a comma-separated string (the form the settings editor writes) or a JSON
 * array of strings (the natural hand-written form in settings.json). Non-string array items are dropped.
 */
function splitLanCsv(raw: unknown): string[] {
  const parts =
    typeof raw === "string"
      ? raw.split(",")
      : Array.isArray(raw)
        ? raw.flatMap((item) => (typeof item === "string" ? item.split(",") : []))
        : [];
  return parts.map((s) => s.trim()).filter((s) => s !== "");
}

/** §9.1 `webHub.lan.extraHosts`: 逐项 `classifyHostToken`；合法项进入白名单，非法项进入 `invalidExtraHosts`（不进白名单，不报错）。 */
function validateExtraHosts(raw: unknown): { hosts: string[]; invalid: InvalidHostToken[] } {
  const hosts: string[] = [];
  const invalid: InvalidHostToken[] = [];
  for (const token of splitLanCsv(raw)) {
    const cls = classifyHostToken(token);
    if (cls.ok) hosts.push(cls.host);
    else invalid.push({ token, reason: cls.reason });
  }
  return { hosts, invalid };
}

/** §2.4 `webHub.lan.trustProxyFrom`: 逐项必须是 IPv4 字面量；非法项静静丢弃（不单独列表，跟随 `proxyMismatch` 同步处理）。 */
function validateTrustProxyFrom(raw: unknown): string[] {
  const out: string[] = [];
  for (const token of splitLanCsv(raw)) {
    const cls = classifyHostToken(token);
    if (cls.ok && cls.kind === "ipv4") out.push(cls.host);
  }
  return out;
}

/** §2.4 `webHub.lan.externalOrigins`: 逐项 `parseOrigin` + scheme 必须 `https` + 主机部分再过 `classifyHostToken`。 */
function validateExternalOrigins(raw: unknown): string[] {
  const out: string[] = [];
  for (const token of splitLanCsv(raw)) {
    const parsed = parseOrigin(token);
    if (parsed === undefined || parsed.scheme !== "https") continue;
    const hostOnly = parsed.hostKey.slice(0, parsed.hostKey.lastIndexOf(":"));
    const hostCls = classifyHostToken(hostOnly);
    if (!hostCls.ok) continue;
    out.push(canonicalOrigin(parsed.scheme, parsed.hostKey));
  }
  return out;
}

/** Fail closed even for non-string configured values. Empty CSV/array alone is inactive.
 * Keep the first 64 distinct valid entries; overflow tokens are reported, never silently trusted. */
function parseAllowClients(raw: unknown): { entries: string[]; invalid: InvalidClientCidr[]; denyAll: boolean } {
  const values: unknown[] =
    typeof raw === "string"
      ? raw.split(",")
      : Array.isArray(raw)
        ? raw.flatMap((v) => (typeof v === "string" ? v.split(",") : [v]))
        : raw === undefined
          ? []
          : [raw];
  const entries: string[] = [];
  const invalid: InvalidClientCidr[] = [];
  let configured = false;
  for (const value of values) {
    if (typeof value === "string" && value.trim() === "") continue;
    configured = true;
    // JSON-valid objects may shadow toString/valueOf; never execute them for diagnostics.
    const token =
      typeof value === "string"
        ? value.trim()
        : value === null || typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : `<${typeof value}>`;
    const canonical = typeof value === "string" ? parseClientCidr(token) : undefined;
    if (canonical === undefined) invalid.push({ token, reason: "syntax" });
    else if (entries.includes(canonical)) continue;
    else if (entries.length >= CLIENT_ALLOW_MAX) invalid.push({ token, reason: "limit" });
    else entries.push(canonical);
  }
  return { entries, invalid, denyAll: configured && entries.length === 0 };
}

export interface WebHubLanParseResult {
  lan: WebHubLanSettings;
  /** §9.1: settings 解析时被丢弃的 `extraHosts` 项（status 列出，never `bad-config`）。 */
  invalidExtraHosts: InvalidHostToken[];
  invalidAllowClients: InvalidClientCidr[];
  /** §2.4: `trustProxyFrom`/`externalOrigins` 只设了其中一半 ⇒ 两者都被清空（fail-closed）。 */
  proxyMismatch: boolean;
}

/**
 * `webHub.lan` 块的唯一解析入口（L16 第一处，§9.1）。`webHubPort` 是已解析的 `webHub.port`（同时不能与
 * `lan.port` 相等，否则回退到默认 lan.port；默认本身碰撞的极端情形留给 hub 启动时的第二道校验，§9.1/§4）。
 * 从不 throw，从不修改入入参。
 */
export function parseWebHubLanBlock(input: unknown, webHubPort: number): WebHubLanParseResult {
  const defaults = DEFAULT_WEBHUB_LAN_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { lan: { ...defaults }, invalidExtraHosts: [], invalidAllowClients: [], proxyMismatch: false };
  }
  const record = input as Record<string, unknown>;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : defaults.enabled;
  const portRaw = record.port;
  let port =
    typeof portRaw === "number" && Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65_535
      ? portRaw
      : defaults.port;
  if (port === webHubPort) port = defaults.port; // §9.1: 必须与 webHub.port 不同；碰撞回退默认（若默认亦碰撞，hub 层的 checkLanPortConflict 否决）
  const { hosts: extraHosts, invalid: invalidExtraHosts } = validateExtraHosts(record.extraHosts);
  const { entries: allowClients, invalid: invalidAllowClients, denyAll } = parseAllowClients(record.allowClients);
  const sessionIdleMinutes = clampSpawnInt(record.sessionIdleMinutes, 5, 10080, 720);
  let trustProxyFrom = validateTrustProxyFrom(record.trustProxyFrom);
  let externalOrigins = validateExternalOrigins(record.externalOrigins);
  let proxyMismatch = false;
  if ((trustProxyFrom.length === 0) !== (externalOrigins.length === 0)) {
    trustProxyFrom = [];
    externalOrigins = [];
    proxyMismatch = true;
  }
  return {
    lan: {
      enabled,
      port,
      extraHosts,
      trustProxyFrom,
      externalOrigins,
      allowClients,
      sessionIdleMinutes,
      ...(denyAll ? { allowClientsDenyAll: true as const } : {}),
    },
    invalidAllowClients,
    invalidExtraHosts,
    proxyMismatch,
  };
}

/**
 * Settings-level LAN warnings (plan §9.1/§2.4) for status-line consumers — pure re-derivation of
 * the same raw `webHub.lan` block `parseWebHubSettings` already validated, so `/webhub status`
 * (or any other caller wired with the raw settings snapshot) can render `formatInvalidExtraHostsLine`/
 * `formatProxyMismatchLine` (`web-hub/agent/lan-status.ts`) without re-implementing §2.1/§2.4.
 */
export function parseWebHubLanValidation(
  input: unknown,
  webHubPort: number,
): { invalidExtraHosts: InvalidHostToken[]; invalidAllowClients: InvalidClientCidr[]; proxyMismatch: boolean } {
  const { invalidExtraHosts, invalidAllowClients, proxyMismatch } = parseWebHubLanBlock(input, webHubPort);
  return { invalidExtraHosts, invalidAllowClients, proxyMismatch };
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

/** Parse the optional `title` settings block（任务 #12 + v2 + rolling-window plan）：逐字段回退默认，never throws；model 串只 trim 不校验——strict 校验在运行时 parseStrictModelRef，解析失败自行回落会话模型。四个计数键（refreshEveryInputs/refreshAfterMinutes/refreshWindowMinutes/maxRefreshes）：`Number.isSafeInteger(x) && x >= 0` 否则回默认；字符串数字（如 "4"）不接受。 */
export function parseTitleSettings(input: unknown): TitleSettings {
  const defaults = DEFAULT_SETTINGS.title;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const nonNegativeInt = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : fallback;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    // 空串是合法哨兵（跟随会话模型）：保留；非字符串回默认。运行时 strict 解析
    // 失败/找不到 provider 也自行回落会话模型（见 TitleSettings.model 注释）。
    model: typeof value.model === "string" ? value.model.trim() : defaults.model,
    refreshEveryInputs: nonNegativeInt(value.refreshEveryInputs, defaults.refreshEveryInputs),
    refreshAfterMinutes: nonNegativeInt(value.refreshAfterMinutes, defaults.refreshAfterMinutes),
    refreshWindowMinutes: nonNegativeInt(value.refreshWindowMinutes, defaults.refreshWindowMinutes),
    maxRefreshes: nonNegativeInt(value.maxRefreshes, defaults.maxRefreshes),
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
    childSessions: typeof value.childSessions === "boolean" ? value.childSessions : defaults.childSessions,
    childMaxSwitches:
      typeof value.childMaxSwitches === "number" &&
      Number.isFinite(value.childMaxSwitches) &&
      value.childMaxSwitches >= 1 &&
      value.childMaxSwitches <= 20
        ? Math.floor(value.childMaxSwitches)
        : defaults.childMaxSwitches,
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
  // bash-timeout-grace §5.1: non-negative integer count, falling back field-by-field like every
  // other bashJobs numeric knob (childSettleHoldMaxRounds / maxExtensions share this shape; `0` is
  // a legal value for both — auto / extend-disabled — so it is never special-cased away from `defaults`).
  const intCount = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : fallback;
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
    // bash-timeout-grace §5.1 (U1/U2): non-boolean falls back to the default (true for both).
    childSessions: typeof value.childSessions === "boolean" ? value.childSessions : defaults.childSessions,
    childSettleHold: typeof value.childSettleHold === "boolean" ? value.childSettleHold : defaults.childSettleHold,
    // §5.1 (C3): no "unlimited" value — non-integer/negative falls back to 0 (auto), not silently clamped.
    childSettleHoldMaxRounds: intCount(value.childSettleHoldMaxRounds, defaults.childSettleHoldMaxRounds),
    // §5.1 (U4): timeoutGraceMs allows 0 (grace off), matching the `num` helper's own 0-is-legal rule.
    timeoutGraceMs: num(value.timeoutGraceMs, defaults.timeoutGraceMs),
    maxExtensions: intCount(value.maxExtensions, defaults.maxExtensions),
    // §5.1 (U4): factor is a multiplier, not a duration — allowed to be fractional, floor is 1 (not 0).
    maxTimeoutFactor:
      typeof value.maxTimeoutFactor === "number" &&
      Number.isFinite(value.maxTimeoutFactor) &&
      value.maxTimeoutFactor >= 1
        ? value.maxTimeoutFactor
        : defaults.maxTimeoutFactor,
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
    isolationReplay:
      value.isolationReplay === "verify" || value.isolationReplay === "off"
        ? value.isolationReplay
        : defaults.isolationReplay,
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
        const now = existsSync(path) ? readFileSync(path, "utf8") : undefined;
        if (now !== rawText) throw new Error("the file changed while migrating");
        const tmpPath = `${path}.${process.pid}.tmp`;
        writeFileSync(tmpPath, JSON.stringify(cache.value, null, 2) + "\n", "utf8");
        renameSync(tmpPath, path);
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
export function persistSettingOverride(
  dottedKey: string,
  value: unknown,
  path: string = defaultSettingsPath(),
): string | undefined {
  // data-encryption P1 review #5: the whole re-read → merge → write runs under the cross-process
  // settings lock shared with the `pi-secure` launcher; a lock failure refuses the write.
  const outcome = withSettingsFileLock(path, (): string | undefined => {
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
