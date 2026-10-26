export type Millis = number;
export type RunId = string;
export type AgentTypeName = string;
export type Generation = number;
export type TimerId = string;

import type { CanMessage, WakeExclusion, WakeOrigin } from "./message.js";
import type { DispatchMeta } from "./dispatch-meta.js";
import type { SchemaPresetId } from "./verdict-schema.js";

export type RunPhase =
  | "queue_wait"
  | "resolve_config"
  | "session_create"
  | "extension_bind"
  | "prompt_dispatch"
  | "model_turn"
  | "tool_exec"
  | "retry_backoff"
  | "compaction"
  | "abort_grace"
  | "reap"
  | "settled";
export type RunStatus =
  "queued" | "starting" | "running" | "stopping" | "completed" | "failed" | "timed_out" | "aborted";
export type TimeoutReason =
  | "queue_timeout"
  | "session_create"
  | "extension_bind"
  | "no_first_event"
  | "idle"
  | "compaction"
  | "total"
  | `tool:${string}`;
export type StopCause = "parent_abort" | "user_stop" | "timeout" | "shutdown" | "parent_gone";
export type ErrorKind =
  | "config"
  | "auth"
  | "startup_transient"
  | "model"
  | "timeout"
  | "aborted"
  | "internal"
  /** X10: run reached a terminal state without a schema-valid StructuredOutput submission. */
  | "schema";

/** X10: opaque JSON Schema object (subset validated by core/json-schema.ts). */
export type JsonSchema = Record<string, unknown>;
/**
 * fabric-cross-session plan v3 §4.1/§4.6: typed cause of a spawn ADMISSION rejection (spawn-service `{ error }`
 * returns). Purely an additive annotation — `kind`/`message`/`retryable` are unchanged and no existing caller reads
 * it; W3/W5 map it for revive (park vs refuse vs retry). Never written to a run entry (admission errors create none).
 * `stack_closed` has no producer in spawn-service itself: it is reserved for the late-bound stack wiring (W5).
 */
export type AdmissionReason =
  | "pool_full"
  | "load"
  | "quota"
  | "resume_locked"
  | "session_closing"
  | "target_running"
  | "stack_closed"
  | "unknown_type"
  | "external_unavailable"
  | "inbox_persist_failed"
  | "config";
export interface ErrorInfo {
  kind: ErrorKind;
  message: string;
  stack?: string;
  retryable: boolean;
  /** Admission rejections only (see {@link AdmissionReason}). */
  reason?: AdmissionReason;
}

export interface DeadlineBudget {
  queueWaitMs: Millis;
  startupMs: Millis;
  bindMs: Millis;
  firstEventMs: Millis;
  idleMs: Millis;
  /** 单轮模型调用的硬上限（不论是否仍在产出 delta）；0 = 不限制，仅受 totalMs 约束。 */
  modelTurnMs: Millis;
  toolMs: Millis;
  compactionMs: Millis;
  /** 总预算。恒 > 0：非法值（≤ 0 / 非有限数）由 mergeBudget 逐层丢弃并回退下一层（D-11）。 */
  totalMs: Millis;
  abortGraceMs: Millis;
  steerMs: Millis;
  reapMs: Millis;
  startupRetries: number;
  retrySlackMs: Millis;
  /** 总预算到点后的续跑宽限；0 = 关闭宽限（到点即按原逻辑终止）。 */
  totalGraceMs: Millis;
  /** 单个 run 允许的 deadline 延长次数上限；0 = 禁止延长（同时也禁用宽限：graceWindow 经 extendability 判额度）。 */
  maxExtensions: number;
  /** 硬天花板倍数：hardDeadlineAt = enqueuedAt + max(ceil(totalMs * maxTotalFactor), totalMs + maxExtensions*extendStepMs)（≥ 1，step 项仅当 factor>1 且 maxExtensions>0 且 extendStepMs>0）。被 applyBudgetPolicy({ fixedDeadline: true }) 钳为 1（fixed-deadline run：H = D0，无宽限无延长；agent-explicit-timeout-extend plan §2.2）。 */
  maxTotalFactor: number;
  /** 单次延长额度上限（用户拍板「每次延长最多 1h」；default 3_600_000）；同时参与 extendable run 的硬顶跨度（T + maxExtensions·extendStepMs）。0 = legacy：不设单次上限、不加 step 硬顶项。 */
  extendStepMs: Millis;
}
export interface RunDeadlines {
  readonly enqueuedAt: Millis;
  /** 当前生效的软截止。**只可向后移动**，且只经由 deadline_extended，且 ≤ hardDeadlineAt。 */
  readonly deadlineAt: Millis | undefined;
  readonly queueDeadlineAt: Millis | undefined;
  /** 续跑宽限截止；undefined = 不在宽限中。进宽限时置位，被延长时清除；**终态时保留作审计痕迹**（BL-5）。 */
  readonly graceUntil?: Millis;
  /**
   * 绝对硬天花板：enqueue 时算一次、永久冻结（原 deadlineAt 的 B1 不变量迁移至此）。
   * = min(enqueuedAt + ceil(totalMs * maxTotalFactor), SpawnRequest.deadlineAt ?? ∞)
   * 配置层已禁止 totalMs ≤ 0（D-11），故正常路径下必有值；undefined 分支仅为防御（直接喂 reducer 的测试输入）。
   */
  readonly hardDeadlineAt?: Millis;
}

/**
 * Thinking levels accepted by agent-type frontmatter (`thinking:`) and by the
 * per-spawn `SpawnRequest.thinkingOverride` / Agent-tool `thinking` parameter.
 * pi itself knows more levels (minimal/xhigh) but the subagent surface
 * deliberately exposes only these four (config/agent-types.ts).
 */
export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * Timeout-policy 分类的取值（agent-explicit-timeout-extend plan §2.2）。
 * - "fixed": 硬顶 —— 不宽限、不延长（applyBudgetPolicy 钳 maxTotalFactor = 1，⇒ H === D0）。
 * - "extendable": 复用默认预算旋钮（totalGraceMs / maxExtensions / maxTotalFactor）宽限与延长。
 * 缺省语义 = "fixed"（fail-safe + 兼容：workflow 子 run / consult / goal / tidy / RPC 全部程序派生显式预算保持硬顶）。
 */
export type TimeoutPolicy = "fixed" | "extendable";

export interface AgentTypeConfig {
  name: AgentTypeName;
  displayName?: string;
  description: string;
  systemPrompt: string;
  promptMode: "replace" | "append";
  tools?: string[];
  model?: { provider: string; id: string };
  /**
   * Raw frontmatter `model:` value when it is NOT a strict `provider/id`
   * pair — a fuzzy hint (bare id or substring alias, e.g. "sonnet"),
   * resolved against pi's available models at spawn admission
   * (src/config/model-hint.ts). `model` (strict pair) and `modelHint` are
   * mutually exclusive per type; a strict pair never needs resolving.
   */
  modelHint?: string;
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  color?: string;
  budgetOverride?: Partial<DeadlineBudget>;
  sourcePath?: string;
  /**
   * X3: agent type names this type is allowed to spawn as nested subagents.
   * Undefined/empty = this type cannot nest (no Agent tool is injected into
   * its own session). This is a declaration on the *parent* type, distinct
   * from `tools` (frontmatter `tools` still gates the host's own top-level
   * Agent tool visibility if used there; `canSpawn` gates the *injected*
   * nested Agent tool's subagent_type whitelist and, authoritatively, the
   * spawn-service-level depth/whitelist check — architecture §7.2 X3).
   */
  canSpawn?: string[];
  /** Frontmatter `can_message`: relations this run may address through fabric. */
  canMessage?: CanMessage[];
}
/**
 * Legacy consult sentinel agent type (#40). The consult tool is gone, but run entries written before the
 * removal can still carry `agentType: "consult:main-snapshot"`; renderers fold it to `"main"` through
 * `displayAgentType`. Nothing produces it any more.
 */
export const LEGACY_CONSULT_MAIN_AGENT_TYPE = "consult:main-snapshot";

/**
 * Presentation-layer name for a run's agent type: folds the legacy consult sentinel
 * (`LEGACY_CONSULT_MAIN_AGENT_TYPE`, only present on pre-removal run entries) to `"main"` so the internal
 * name never reaches a user-facing surface. Identity for every other type name; `undefined` passes through
 * untouched. Safe to apply repeatedly ("main" is not the sentinel).
 */
export function displayAgentType(type: string): string;
export function displayAgentType(type: string | undefined): string | undefined;
export function displayAgentType(type: string | undefined): string | undefined {
  return type === LEGACY_CONSULT_MAIN_AGENT_TYPE ? "main" : type;
}

export interface InputBudget {
  maxInputTokens: number;
  bytesPerToken: 2;
}

export interface DispatchMeasure {
  maxInputTokens: number;
  bytesPerToken: 2;
  preBytes: number;
  preTokens: number;
  payloadBytes?: number;
  payloadTokens?: number;
}

export interface SpawnRequest {
  /** Dispatch-time input budget; the runtime measures both its coarse preflight and final provider payload. */
  inputBudget?: InputBudget;
  /** Assigned run identifier, used by lifecycle extensions for resource names. */
  runId?: RunId;
  type: AgentTypeName;
  prompt: string;
  label?: string;
  /**
   * Display-only title: the Agent tool's raw `description`, captured by
   * `captureDisplayTitle` (first non-empty line, control chars stripped,
   * whitespace preserved, ≤120 code points). Spawn admission keeps it only
   * when it differs from the effective label (otherwise omitted, so a
   * label-shaped description adds no bytes anywhere). Surfaced as the fleet
   * row's main title in the web UI while `label` stays the @mention handle.
   */
  title?: string;
  cwd?: string;
  modelOverride?: { provider: string; id: string };
  /**
   * Free-form Agent tool `model` param value that is not a strict
   * `provider/id` pair — resolved as a fuzzy hint at spawn admission.
   * Takes precedence over the agent type's `modelHint`, loses to a strict
   * `modelOverride`/`config.model` pair.
   */
  modelHintOverride?: string;
  /**
   * Per-spawn thinking-level override (Agent tool `thinking` param): takes
   * precedence over the agent type's configured `thinkingLevel` when set;
   * unset = the type's frontmatter `thinking:` (or pi's global default when
   * the type defines none). Merged into `sessionSpec.thinkingLevel` by the
   * runtime adapter, same pattern as `modelOverride`.
   */
  thinkingOverride?: ThinkingLevel;
  /**
   * Per-spawn budget override. `totalMs` 有值 ⇒ 该 run 为显式预算 run：spawn-service
   * 用 applyBudgetPolicy 钳 maxTotalFactor = 1（硬顶，无宽限无延长）。
   * timeoutPolicy（agent-explicit-timeout-extend plan §2.2）：spawn admission 按解析式
   * （req.timeoutPolicy ?? resume 继承 ?? 按 budgetOverride.totalMs 形状推导 "fixed"/"extendable"）
   * 把它解析成确定值写回 resolvedReq；此后 run 生命周期内恒为确定值（"fixed" 或 "extendable"），
   * 模型面只有 Agent 工具传 timeout_s 时写 "extendable"，其余调用方不写（缺省按形状推导为 "fixed"）。
   */
  timeoutPolicy?: TimeoutPolicy;
  budgetOverride?: Partial<DeadlineBudget>;
  /**
   * fabric-cross-session plan §4.1: provenance of a wake revive. Only programs write it (WakeService, W5); it is
   * deliberately NOT threaded into the child (request-threading `NOT_THREADED`) and is mirrored write-once into
   * `diag.wakeOrigin` (without `trigger.claimToken`) by later packages.
   */
  wakeOrigin?: WakeOrigin;
  /**
   * fabric-cross-session plan §4.1/§3.5: spawn-service-internal marker (set only when an inbox reservation was bound
   * to this resume). It switches on the runner/reducer acceptance markers (`promptDispatchedAt`,
   * `inputAcceptedAt`, `promptOutcome`) — threaded to the runner (`THREADED`), never settable by a model-facing
   * tool. Absent ⇒ every persisted byte is exactly what it was before wake existed.
   */
  trackInput?: true;
  /**
   * fabric-cross-session plan §3.3 L4: the run's INITIAL effective causal level. Spawn-service-internal — it is
   * (re)computed from scratch at admission whenever causal levels are wired (`wakeOn`), so a caller-supplied value
   * is never trusted; threaded to the runner, which seeds `diag.wakeLevel` through the reducer's `wake_level` input.
   * Absent ⇒ wake is off ⇒ every persisted byte is exactly what it was before wake existed.
   */
  wakeLevel?: number;
  /**
   * fabric-cross-session plan §3.3 L4: programmatic marker for a resume that is itself a causal hop by a node at
   * this level (the legacy `@label` mention resume — which is never blocked but still propagates). Spawn-service
   * seeds `wakeLevel = max(wakeHopLevel + 1, prevFinal)`. Only programs write it; never threaded into a child.
   */
  wakeHopLevel?: number;
  /**
   * fabric-cross-session plan §4.5 (W5): the admission-time wake-ability verdict. Computed by spawn admission ONLY
   * when the wake inbox is wired (a caller-supplied value is stripped), then mirrored write-once into
   * `diag.wakeExclusion` through the adapter's display meta. Never threaded to the runner or a child.
   */
  wakeExclusion?: WakeExclusion | "none";
  /**
   * W5: set by programs that own this run's result (workflow children, which hand the outcome to an `agent()` call):
   * such a run is never revivable by a message (`wakeExclusion: "caller_owned"`). Consumed by admission only.
   */
  callerOwned?: true;
  slotless?: boolean;
  parentRunId?: RunId;
  /** Caller will synchronously acknowledge the terminal outcome. */
  expectAck?: boolean;
  /** Caller owns all completion reporting; suppress terminal outbox delivery. */
  suppressDelivery?: boolean;
  /**
   * Request an isolated git worktree for this run. Created from the current
   * HEAD (uncommitted main-checkout changes are not visible); on reap all
   * changes are committed to a `pi-agent-<runId>` branch and the worktree is
   * removed. Fails as `failed(config)` with no fallback when unavailable.
   */
  isolation?: "worktree";
  signal?: AbortSignal;
  /**
   * When true, the external `signal` only takes effect during spawn
   * admission (the existing `external?.aborted` immediate-cancel check in
   * createCancelHandle is unaffected); once the run starts, the runner
   * detaches the external listener so an abort of the caller's turn (Esc /
   * compact_context / compact-hint forced compaction) no longer cancels
   * this run. Only for fire-and-forget background spawns — blocking
   * spawnAndWait callers (nested Agent, workflow, /goal verifier) keep
   * full-turn linkage on purpose (Esc killing a run the turn is blocked
   * on is a feature). Cancellation paths that go through
   * activeCancels (abort_subagent, watchdog timeout, ...) are unaffected
   * because detach only removes the external listener.
   */
  detachSignalOnStart?: boolean;
  /** Resume a terminal run by run id or directly by its persisted session file. */
  resumeFrom?: string;
  /**
   * X10: require the subagent to submit its final result through an
   * injected StructuredOutput tool matching this JSON Schema. Validated both
   * at submission time (child-side, inside the injected tool) and again
   * independently against the raw captured payload once the run reaches a
   * terminal state (host-side) — architecture §7.2 X10 "双重校验".
   */
  schema?: JsonSchema;
  /**
   * CC4: absolute wall-clock upper bound (epoch millis) on this run's
   * deadline. Semantics:
   *   ① the run's deadlines.deadlineAt = min(enqueuedAt + budget.totalMs, deadlineAt)
   *   ② only tightens, never loosens (min() makes this automatic)
   *   ③ B1 "computed once at enqueue, then frozen forever" now protects
   *      deadlines.hardDeadlineAt = min(enqueuedAt + ceil(totalMs * maxTotalFactor), deadlineAt);
   *      deadlineAt itself is the initial soft cap — it may only move LATER,
   *      only via deadline_extended, and never beyond hardDeadlineAt
   *   ④ if already expired at enqueue time -> failed(config, "deadlineAt already expired"),
   *      without acquiring a slot or creating a session (see CP1/CP2/CP3)
   *   ⑤ must be threaded through every hop explicitly (service/request-threading.ts)
   *      or it is silently dropped — this repo has prior art for that failure mode
   *      (see ResolvedSpawnRequest.parentRunId below).
   */
  deadlineAt?: Millis;
  /**
   * consult A/B instrumentation plan (§3): optional analytics-only metadata
   * set by the Agent tool's `meta` param (top-level only, never nested — see
   * §3). `NOT_THREADED` by request-threading.ts; the runtime adapter copies it
   * verbatim into `RunDisplayMeta.dispatchMeta`, and the `enqueued` reducer
   * branch mirrors it into `diag.dispatchMeta` exactly once (write-once,
   * never revised). `buildPrompt` never reads it — it is never visible to the
   * subagent. Never threaded into resume's `ResolvedSpawnRequest` by this
   * field alone; resume inheritance (D3) is a P1b/service-layer concern.
   */
  dispatchMeta?: DispatchMeta;
  /**
   * consult A/B instrumentation plan (§4): resolved preset id when the
   * Agent tool's `schema` param named a known preset (e.g. `"verdict/v1"`)
   * instead of a literal JSON Schema object. Write-once at dispatch,
   * mirrored into `RunDisplayMeta.schemaPreset`/`diag.schemaPreset`; used at
   * settle time to pick `renderStructuredForHost`'s report-plus-verdict
   * rendering over a raw `JSON.stringify`. Independent of `schema` itself,
   * which still carries the resolved JSON Schema object for validation.
   */
  schemaPreset?: SchemaPresetId;
  /**
   * L1 (agent-tool pool-full plan §1/§2): admission-time policy when this
   * (non-slotless) request would exceed the concurrency pool. `"reject"` —
   * fail admission immediately (no run, no worktree, no record) with a
   * self-explanatory config error; `"queue"` — the pre-L1 behavior (proceed
   * to the real SlotPool queue, bounded by `budget.queueWaitMs`). Undefined
   * (every caller except the top-level/nested Agent tool: workflow children,
   * /task, resume) is also "queue" — this field only ever
   * narrows admission, never widens it. Ignored entirely for `slotless`
   * requests, which never occupy a conceptual slot in the first place.
   */
  poolFullPolicy?: "reject" | "queue";
  /**
   * sysload plan (docs/dev/sysload/plan.md §6.2/§6.3): admission-time load gate for a
   * non-slotless top-level/nested Agent-tool dispatch. `"reject"` — fail admission immediately
   * (no run, no label, no worktree) with a self-explanatory config error when the effective load
   * gate (§5.3) is active; absent — never load-gated at admission (every caller except the
   * top-level/nested Agent tool: workflow children, `/task`, `@mention`, RPC
   * spawn, cron, resume — §6.3's entry matrix). Written ONLY by `createAgentTool`'s
   * `prepareSpawn` when `deps.loadGate?.()` is true; checked by `spawn-service.ts` AFTER the
   * quota gate and BEFORE nesting/runId/label (§6.2). Mutually independent of `poolFullPolicy`
   * (pool-full is checked first — §6.2 "pool-full（已有）先于 load").
   */
  loadPolicy?: "reject";
  /**
   * P0-r (todo #22 memory optimize-plan §7.0/§7.0.0): request the runtime's
   * forced read-only tool domain for this run, so `/mem tidy`'s proposal-drafting
   * subagent gets zero write-capable tools without a second mechanism.
   * `readonlyDomain = toolDomain === "readonly"` (runtime-adapter.ts). Threat model (§7.0.0): this defends against the
   * RUN'S OWN MODEL calling a write tool, not against a same-process
   * malicious extension — trusting same-process code is this package's
   * existing trust boundary. Only ever set
   * by an in-process caller (the tidy port) that constructs its own
   * `SpawnRequest` field-by-field; the Agent tool / RPC spawn / workflow
   * `agent()` opts all reject or silently drop an unknown key, so a model
   * can never set this itself (N6). Mutually exclusive with `isolation` /
   * `resumeFrom` — spawn admission rejects the
   * combination as a config error (§7.0 point 4) since tidy never needs any
   * of them and combining them would be a latent misuse waiting to happen.
   */
  toolDomain?: "readonly";
}
/**
 * M-A (presentation): one observed tool call of a run, kept in
 * RunDiagnostics.toolHistory (bounded ring, TOOL_HISTORY_CAP) so both the
 * progress tool cards (get_run_result wait, workflow) and the fleet/agent-tree widget can render a
 * live execution trail without re-reading the child session file.
 */
export interface ToolCallRecord {
  name: string;
  toolCallId: string;
  startedAt: Millis;
  endedAt?: Millis;
  isError?: boolean;
  /** Truncated single-line preview of the tool arguments (display only). */
  argsPreview?: string;
}

/** M-A (presentation): display-only spawn metadata threaded into diag at enqueue time. */
export interface RunDisplayMeta {
  model?: { provider: string; id: string };
  label?: string;
  /** Display-only raw title (SpawnRequest.title), kept only when it differs from the label. */
  title?: string;
  agentType?: string;
  /** Truncated dispatch prompt for agent-tree previews and /agent status. */
  taskPrompt?: string;
  /** X1 (agent tree): set for `isolation:"worktree"` spawns as `{ state: "active" }`;
   *  beforeReap later replaces it with the disposal outcome via setWorktreeDisposition. */
  worktree?: WorktreeDisposition;
  /**
   * consult A/B instrumentation plan (§3): mirrors `SpawnRequest.dispatchMeta`
   * verbatim, written exactly once at enqueue and never revised afterwards.
   * Read-only from here on. Absent when the dispatcher passed no `meta`, and
   * on every run persisted before this plan shipped (old entries may lack it).
   */
  dispatchMeta?: DispatchMeta;
  /**
   * consult A/B instrumentation plan (§4): mirrors `SpawnRequest.schemaPreset`
   * verbatim, written exactly once at enqueue and never revised afterwards.
   * Read-only from here on. Absent when the dispatcher's `schema` did not
   * name a known preset, and on every run persisted before this plan shipped
   * (old entries may lack it).
   */
  schemaPreset?: SchemaPresetId;
  /** fabric-cross-session plan §4.1 (W5): wake provenance (without `trigger.claimToken`), folded write-once by `enqueued`. */
  wakeOrigin?: WakeOrigin;
  /** fabric-cross-session plan §4.5 (W5): admission-time wake-ability verdict, folded write-once by `enqueued`. */
  wakeExclusion?: WakeExclusion | "none";
}

/**
 * X1 (agent tree): display-only worktree isolation state behind the fleet
 * rows' `⎇` marker. "active" is folded in at enqueue (the run was spawned
 * with isolation:"worktree" and is in flight); the terminal states are the
 * post-reap disposal outcome reported by the worktree extension.
 */
export interface WorktreeDisposition {
  state: "active" | "committed" | "kept" | "clean";
  /** Branch the worktree changes were committed to (state "committed"), e.g. `pi-agent-<runId>`. */
  branch?: string;
  /** workflow-worktree plan D5-core: filled in by the extension when state is "kept" so callers can point the user at the on-disk directory. */
  path?: string;
  /** replay-verify plan D1: only present for state "committed", and only when H3's post-commit `rev-parse HEAD` succeeded. Absent ≠ not committed — the commit itself is still safe, just unreported. */
  commit?: string;
}

/** X1: the post-reap subset an extension may report back (no "active"). workflow-worktree plan D5-core adds `path?` (kept dispositions only); replay-verify plan D1 adds `commit?` (committed dispositions only). */
export type WorktreeDisposal = {
  state: "committed" | "kept" | "clean";
  branch?: string;
  path?: string;
  commit?: string;
};

// ── 外部 agent（external-agent plan §2.1，冻结面）：定价 / run 规格 / 诊断 ──

/** USD per 1M tokens（与 pi ModelCost 同口径）。 */
export interface ExternalPriceRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface ExternalPriceTier extends ExternalPriceRates {
  /** 与 pi ModelCostTier 同义：单次请求 input 总量超过此值时整次请求用该档。 */
  inputTokensAbove: number;
}
export interface ExternalPriceTable extends ExternalPriceRates {
  tiers?: readonly ExternalPriceTier[];
}
/** 价格从哪来：override=用户覆盖；upstream=droid 标注的上游 provider 的官方条目；family=按模型家族前缀推断的厂商条目；
 *  consensus=无规范 provider 时多个注册表条目价格一致。 */
export type ExternalPricingBasis = "override" | "upstream" | "family" | "consensus";
export type ExternalUnpricedReason =
  | "no_match"
  | "ambiguous"
  | "zero_price"
  | "router_model"
  | "override_unpriced"
  | "invalid_override"
  | "registry_unavailable";
export type ExternalPricing =
  | {
      status: "priced";
      source: string; // "anthropic/claude-opus-5-5" | "settings"
      basis: ExternalPricingBasis;
      /** basis ∈ {family, consensus} ⇒ true：近似价（如 factory 自托管模型按厂商 API 牌价）。 */
      approx: boolean;
      table: ExternalPriceTable;
    }
  | { status: "unpriced"; reason: ExternalUnpricedReason; detail?: string };

// ── 外部 agent：run 规格（adapter 构造，驱动只读） ──
export interface ExternalContextBlock {
  kind: "memory" | "capabilities";
  text: string;
}
export interface ExternalRunSpec {
  provider: string; // "droid"
  modelId: string; // droid 内模型 id（无 "droid/" 前缀）
  thinkingLevel?: string; // pi 档位；provider 自行映射到 reasoningEffort
  roleName: string; // agent 类型名
  rolePrompt?: string; // 仅 prompt_mode:replace 类型的 systemPrompt
  contextBlocks: readonly ExternalContextBlock[]; // fresh: [memory?, capabilities]；resume: []
  schema?: JsonSchema; // 仅用于渲染「末尾输出 ```json」指令
  persistTranscript: boolean; // = PiSessionDriver 的 persist 口径
  runId: string;
  pricing: ExternalPricing; // planRun 时快照；run 生命周期内不变
  degraded: readonly string[]; // planRun 决定的降级项（§4.8）
}

// ── 外部 agent：诊断 ──
export interface ExternalPricingDiag {
  status: "priced" | "unpriced" | "partial"; // partial = 部分用量无法定价（droid 原生子 agent 用量）
  source?: string;
  basis?: ExternalPricingBasis;
  approx?: true;
  reason?: string; // ExternalUnpricedReason 或 "child_usage"
  detail?: string;
}
export interface ExternalRunMeta {
  provider: string;
  sessionId?: string;
  autonomy?: string; // droid settings echo 的实际 autonomyLevel
  protocolVersion?: string;
  agentVersion?: string;
  credits?: number; // 本 run 累计 factoryCredits（单调）
  thinkingTokens?: number;
  childTokens?: number; // droid 原生子 agent 的 token（不计价）
  pricing?: ExternalPricingDiag;
  permissionApprovals?: number; // 已同步批准的 request_permission 次数
  degraded?: readonly string[];
  nativeSessionFile?: string;
  unknownNotifications?: number;
  /** external-agent plan r3（§14）：异常退出对账补记 usage 成功时置 true（只可为 true）。 */
  reconciled?: true;
}
export type ExternalMetaPatch = Partial<ExternalRunMeta> & { provider: string };

export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  /** U4：本增量/累计里有无法定价的部分。"all"=全部无法定价（costUsd 恒 0）；"partial"=costUsd 只含可定价部分。
   *  pi 驱动永不设置 ⇒ pi run 的 usage 永无此键。 */
  unpriced?: "all" | "partial";
}
export interface ContextUsageInfo {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}
export type DriverEvent =
  /** plan §4.7: pi emitted `message_end{role:"user"}` — the prompt (or resume input) is now in the session. Reducer branch lands in W2. */
  | { t: "input_accepted" }
  | { t: "turn_start" }
  | { t: "turn_end"; toolResults: number }
  | {
      t: "message_end";
      usage?: UsageDelta;
      /**
       * X12: run ids whose lifetime spend rode into THIS run's X9 accumulator
       * on this usage-bearing toolResult (nested Agent / get_run_result).
       * Extracted by the session driver from the pi message's
       * `details` (runId / runIds); only present when the
       * message carries usage (a background-spawn ack references a run whose
       * spend is NOT yet inside the parent). Cost consumers (usage broadcast,
       * /agent costs) use it to avoid double-counting the nested run.
       */
      absorbedRunIds?: readonly string[];
    }
  | { t: "context_usage"; usage: ContextUsageInfo }
  | { t: "tool_start"; toolCallId: string; toolName: string; argsPreview?: string }
  | {
      t: "tool_end";
      toolCallId: string;
      toolName: string;
      isError: boolean;
    }
  | { t: "tool_update"; toolCallId: string }
  | { t: "retry_start"; attempt: number; maxAttempts: number; delayMs: Millis }
  | { t: "retry_end"; success: boolean }
  | { t: "compaction_start"; reason: string }
  /**
   * child-context-switch plan P0 (§2.3.1): `failed` is set (true only, never
   * false — exactOptionalPropertyTypes) by the driver when pi's own raw
   * event carried a non-empty `errorMessage` and `aborted` is false — i.e.
   * pi's automatic compaction itself failed (threshold summarization error,
   * overflow compact-and-retry exhausted, …). Absent/undefined means the
   * compaction was either aborted or genuinely succeeded; the driver also
   * emits a companion `compaction_failed` event in that same case (never for
   * an aborted compaction) so the reducer can keep a bounded failure ring
   * independent of this per-event flag.
   */
  | { t: "compaction_end"; aborted: boolean; failed?: true }
  | { t: "settled" }
  | { t: "text_delta"; delta: string }
  | { t: "thinking_delta"; delta: string }
  /** set_model: the live session's model was switched mid-run (display-only diag patch; see state-machine.ts reduce's early-return branch).
   *  `thinking` carries the post-switch effective thinking level (read back from the session,
   *  so it reflects pi's clamping) when the handle exposes one — absent keeps the previous level. */
  | { t: "model_changed"; model: { provider: string; id: string }; thinking?: string }
  /**
   * child-context-switch plan P0 (§2.3.1/§2.4): three best-effort diagnostic
   * events, all handled in the SAME reduce() branch as `context_usage` above
   * (accepted in every state including terminal/stale-generation, patch
   * `diag` only, no effect, `lastEventAt`/`lastEventType` untouched — see
   * state-machine.ts). The session driver maps them from `entry_appended`
   * (a `fromHook` compaction whose `details.source` is the switch tool's
   * marker; a `subagent:switch-selfcheck`/`subagent:switch-capability`
   * custom entry written by the child-session extension) and from a
   * `compaction_end` event that carries a non-aborted `errorMessage`.
   *
   * `context_switch`: one successful boundary-draft context switch was
   * committed to the branch (child-context-switch plan §2.1 step 2).
   */
  | {
      t: "context_switch";
      seq: number;
      keepRecent: boolean;
      dropped: {
        fromEntryId: string;
        toEntryId: string;
        entries: number;
        tokensBefore: number;
        tokensAfterEstimate: number;
      };
    }
  /** pi's own automatic compaction failed (threshold summarization error, overflow retry exhausted, …). `reason` mirrors pi's own `compaction_end.reason` ("manual" | "threshold" | "overflow"); `message` is pi's `errorMessage`. */
  | { t: "compaction_failed"; reason: string; message: string }
  /**
   * The child-session extension detected, at `agent_end`, that its own
   * boundary-draft switch was committed but the run ended right after it
   * without the run ever reaching a subsequent model request (pi runtime
   * semantics changed underneath the plan's assumptions — §3.1 L3(b)). The
   * runner latches the FIRST such reason for this run and gives it priority
   * over `turnError` when settling (never over an existing cancel/timeout).
   */
  | { t: "switch_selfcheck_failed"; reason: string }
  /**
   * The process-level switch_context capability state machine (child-context-
   * switch plan §3.1, owned by a later package) recorded a disablement or
   * other non-fatal capability event for this run's session. Diagnostic only
   * — never affects this run's outcome (unlike switch_selfcheck_failed).
   */
  | { t: "switch_capability"; reason: string }
  /**
   * child-context-switch plan P3 acceptance follow-up (§2.3.1 V1-V6 / "uncommitted"
   * visibility gap): additive best-effort diagnostic for a switch_context call that did
   * NOT commit — either a structural rejection from `buildChildSwitchDrafts` (V1-V6:
   * "unpersisted" | "order" | "concurrent-compaction" | "boundary-conflict" | "cut-point" |
   * "preview-invalid" | "cannot-continue"), the tool-result-not-ok/no-session-file
   * "unpersisted" case, or a `verified`-state self-check recheck failure that does NOT (by
   * itself) disable the capability (a single post-verified "uncommitted" — that case
   * previously had ZERO diagnostic visibility, unlike the disabling paths which already
   * surface through `switch_capability`/`switch_selfcheck_failed`). Same best-effort family
   * as `context_usage` above: diag-only, no effect, accepted in every state. Never affects
   * this run's outcome and never touches the switch-count semantics owned by
   * `compact.childMaxSwitches` (that count is derived from the branch itself, not from this
   * diagnostic).
   */
  | { t: "context_switch_rejected"; reason: string }
  /**
   * bash-timeout-grace plan §3.1/§3.8 (P0b, frozen): the runner's synchronous,
   * end-of-run snapshot of this run's child bash jobs (RunnerDeps.sealSession,
   * dispatched by `sealBeforeTerminal` immediately before the first input that
   * moves the run terminal). Metadata-only, same family as `model_changed` —
   * see state-machine.ts reduce()'s dedicated branch for the exact placement
   * (after the generation check, before effect_failed/terminal(), §3.8) and
   * why it is NOT exempt from the generation check the way model_changed is. */
  | { t: "exit_facts"; facts: RunExitFacts }
  /**
   * fleet-drawer plan §4.1 (review blocker #1, frozen): the session leaf id
   * observed by `RuntimeRunner.sealBeforeTerminal` at the same pre-terminal
   * seal point as `exit_facts` — "the run's prompt settled" is the moment
   * this is read, and everything a reap hook may append afterwards is by
   * construction a DESCENDANT of this leaf, so walking the persisted file
   * from it yields a deterministic branch. Metadata-only, same family as
   * `model_changed`/`exit_facts` (see state-machine.ts reduce()'s sibling
   * branch): NOT exempt from the generation check, terminal states take an
   * explicit reference-equal no-op, non-terminal states get a pure diag
   * patch. Folded into `RunDiagnostics.finalLeafId`; consumers (web-hub
   * fleet drawer, F2/F3) treat a missing value as a determined
   * `leaf_unknown` error and NEVER fall back to the file's physical last
   * line (append-only trees make that line an arbitrary branch tip).
   */
  | { t: "final_leaf"; leafId: string }
  /**
   * todo #27 (child-extension-missing diagnostic, session-driver.ts +
   * src/child/activation-signal.ts): emitted synchronously by
   * `PiSessionDriver.bind()` when this run's child session never activated
   * pi-toolkit at all (the process-wide activation counter did not advance
   * during the create/resume await window). Diagnostic only, same best-effort
   * family as `context_usage`/`compaction_failed` above: accepted in every
   * state (see state-machine.ts's reduce()), no effect, `lastEventAt`/
   * `lastEventType` untouched.
   */
  | { t: "child_extension_missing" }
  | {
      t: "dispatch_measure";
      measure: DispatchMeasure;
    }
  /**
   * 外部 agent（external-agent plan §2.1，冻结面）：外部 provider 的诊断元数据补丁
   * （ExternalMetaPatch）。与 `context_usage` 同族：任意状态（含终态、stale
   * generation）接受，只做 `diag.external = mergeExternalMeta(diag.external,
   * event.meta)`，不刷新 lastEventAt/lastEventType、无 effect（见 state-machine.ts
   * 的 external_meta 分支与 core/external-meta.ts 的合并规则）。PiSessionDriver
   * 永不产生 ⇒ pi run 的 diag 永无 `external` 键。
   */
  | { t: "external_meta"; meta: ExternalMetaPatch };

/**
 * bash-timeout-grace plan §3.1 (P0b, frozen): one child-session bash job as
 * observed at seal time, either still running ("terminating" — a SIGTERM was
 * just sent) or already in one of its terminal job states. Pure data (no pi
 * imports, I1); `logPath` is the job's own log file so a parent can point the
 * user at partial output. At most RunExitFacts.bashJobs.length entries are
 * ever built for one run (state-machine.ts does no truncation itself — the
 * cap is enforced by the producer, src/bash/child-registry.ts).
 */
export interface RunExitJob {
  jobId: string;
  commandPreview: string;
  state: "terminating" | "completed" | "failed" | "timed_out" | "killed";
  exitCode: number | null;
  logPath: string;
  durationMs: Millis;
  /** Whether the child session ever observed this job finish (bash_job wait/status) before the run ended. */
  seen: boolean;
}

/**
 * bash-timeout-grace plan §3.1 (P0b, frozen): the synchronous, read-only
 * exit-time snapshot `ChildBashRegistry.sealAndKill`/`exitFacts()` return,
 * folded into `RunDiagnostics.exitFacts` via the `exit_facts` session_event
 * and carried from there into `RunOutcome.diag`, the terminal `RunSnapshot`
 * and `DeliveryPayload.exitFacts` (§3.7/§3.8) — never rebuilt from anything
 * but this one value once it lands on a run's diag. `bashJobsMore` counts
 * additional non-terminal/unseen jobs beyond the (at most 5) entries in
 * `bashJobs` (see RunExitJob). `hold` (§3.5, written by the child-session
 * settle-hold hook, not by sealSession itself) records the settle-hold
 * round budget outcome for this run, when the hold feature is engaged.
 */
export interface RunExitFacts {
  bashJobs: RunExitJob[];
  bashJobsMore?: number;
  hold?: { rounds: number; cap: number; exhausted: boolean };
}

/**
 * child-context-switch plan P0 (§2.1 step 2 `details.dropped`): the entry
 * range a committed boundary-draft switch_context dropped from the child
 * session's context, mirrored verbatim from the compaction entry's own
 * `details.dropped` (written by the — separately owned — boundary-draft
 * builder). Display/diagnostic only; never re-derived here.
 */
export interface ContextSwitchDroppedRange {
  fromEntryId: string;
  toEntryId: string;
  entries: number;
  tokensBefore: number;
  tokensAfterEstimate: number;
}
/**
 * child-context-switch plan P0 (§2.3.1): best-effort diagnostics folded into
 * `RunDiagnostics.contextSwitches` by the DriverEvent kinds
 * (`context_switch` / `switch_selfcheck_failed` / `switch_capability` /
 * `context_switch_rejected`), surfaced through `get_run_result` and the
 * completion notice. `count`/`last` are written by successful switches;
 * `selfcheck` is the (run-fatal) self-check-failed latch also read by the
 * runner's settlement priority (§2.3.1 point 3); `capability` is a non-fatal
 * capability-state notice owned by a later package's capability state
 * machine (§3.1) — this package only carries the diagnostic plumbing for it.
 * `rejected` (P3 acceptance follow-up, additive) is a bounded FIFO ring of
 * V1-V6 structural rejections and non-disabling "uncommitted" self-check
 * recheck failures — the reasons a model saw in its own turn's failure
 * notice, now also readable by the calling session via get_run_result
 * without changing the switch-count or capability semantics.
 */
export interface ContextSwitchDiag {
  count: number;
  last?: { seq: number; keepRecent: boolean; at: Millis; dropped: ContextSwitchDroppedRange };
  selfcheck?: { reason: string; at: Millis };
  capability?: { reason: string; at: Millis };
  rejected?: { reason: string; at: Millis }[];
}
/**
 * child-context-switch plan P0 (§2.3.1): one observed failure of pi's own
 * automatic compaction (threshold summarization error, overflow
 * compact-and-retry exhausted, …), bounded ring capped at 3 (FIFO) by the
 * reducer. `reason` mirrors pi's own `compaction_end.reason`.
 */
export interface CompactionFailureRecord {
  reason: string;
  message: string;
  at: Millis;
}
/**
 * set_model switch result union (docs/dev/set-model/set-model-plan.md §4.1).
 * The runner returns a reason union instead of throwing (unlike steer) so
 * "unknown_model" stays distinguishable from "the session refused" — the
 * tool turns the two into different, self-correcting messages (§6).
 * Defined here (not in runtime/runner.ts) because core has no pi imports
 * (I1) and runner / ports / query-service / the tool layer all share it.
 */
export type SetModelOutcome =
  | { ok: true; model: { provider: string; id: string }; thinking?: string }
  | { ok: false; reason: "not_running" }
  /** driver/handle does not expose the set_model capability. */
  | { ok: false; reason: "unsupported" }
  /** Not in pi's model registry / no auth configured for the provider. */
  | { ok: false; reason: "unknown_model"; detail: string }
  | { ok: false; reason: "timeout" }
  /** pi refused the switch (e.g. no API key for the provider). */
  | { ok: false; reason: "rejected"; detail: string };

/**
 * fleet-drawer plan §4.1 (#7): the synchronous registration verdict of
 * `RuntimeRunner.observeRun` / `Runner.observe` / `QueryService.observe`.
 * Defined here (not in runtime/runner.ts) for the same reason as
 * SetModelOutcome above: core has no pi imports (I1) and runner / ports /
 * query-service / the web-hub read port (F2) all share it.
 *
 * - `attached`: the observer is live on the run's current session; `detach()`
 *   cancels the subscription WITHOUT firing `onEnd` (idempotent);
 * - `terminal`: the run is already terminal — nothing was registered, the
 *   caller reads the final state on its own;
 * - `no_session`: the run exists and is non-terminal but has no observable
 *   session right now (still queued / creating, handle lacks `observe`, or
 *   the per-run observer cap (16) is exhausted);
 * - `unknown`: no such run in this runner.
 */
export type ObserveRunResult =
  | { kind: "attached"; detach(): void }
  | { kind: "terminal"; status: string }
  | { kind: "no_session" }
  | { kind: "unknown" };
/**
 * fleet-drawer plan §4.1 (#7): the listener half of observeRun. `onEvent`
 * receives the session's raw stream events (opaque `unknown` — I1);
 * `onEnd(status)` fires EXACTLY ONCE per successful attach, either from the
 * terminal dispatch (the linearization point: the central dispatch where
 * `wasTerminal === false && terminal(state.status)`) or from the runner's
 * finally cleanup as a fallback, whichever wins — a per-observer `done`
 * flag guarantees the exactly-once contract across the two racing paths.
 * Every listener callback is exception-swallowed by the runner.
 */
export interface RunObserverListener {
  onEvent(e: unknown): void;
  onEnd(status: string): void;
}

/** v1 只有工具一个来源（D-13）；预留联合类型扩展位。 */
export type ExtendSource = "tool";

/** 送往宿主通知层的纯数据；core 不做任何文案格式化（I1：core 无 pi 依赖）。 */
export interface DeadlineNotice {
  kind: "grace" | "extended";
  runId: RunId;
  generation: Generation;
  at: Millis;
  phase: RunPhase;
  label?: string;
  agentType?: string;
  taskPreview?: string;
  /** 变更后的软截止。 */
  deadlineAt: Millis;
  /** kind === "grace" 时必有：本次宽限的截止时刻。 */
  graceUntil?: Millis;
  hardDeadlineAt: Millis;
  extensionsUsed: number;
  maxExtensions: number;
  /** kind === "grace" 时必有：文案里“可直接抄”的建议值 = min(totalMs, headroom)，core 一次算好（毫秒；文案层换成秒）。 */
  suggestedExtendMs?: Millis;
  /** kind === "extended" 时必有。 */
  requestedMs?: Millis;
  grantedMs?: Millis;
  source?: ExtendSource;
}

/** 与 SetModelOutcome 同置（既有先例）：给工具层生成自纠错文案。 */
export type ExtendOutcome =
  | {
      ok: true;
      runId: RunId;
      previousDeadlineAt: Millis;
      deadlineAt: Millis;
      requestedMs: Millis;
      grantedMs: Millis;
      /** grantedMs < requestedMs（被硬天花板夹过）。 */
      clamped: boolean;
      extensionsUsed: number;
      extensionsRemaining: number;
      hardDeadlineAt: Millis;
      /** 本次延长把 run 从续跑宽限中救了出来。 */
      rescuedFromGrace: boolean;
    }
  | {
      ok: false;
      reason:
        | "unknown_run"
        | "already_terminal"
        | "stopping"
        | "not_started" // queue_wait / resolve_config / session_create / extension_bind（D-14）
        | "uncapped" // 防御性：deadlineAt/hardDeadlineAt 缺席（配置层已禁止 totalMs ≤ 0，见 D-11）
        | "limit_reached"
        | "no_headroom" // 含 D-10 fixed-deadline run（timeoutPolicy "fixed" ⇒ H = deadlineAt；agent-explicit-timeout-extend plan §2.2）
        | "unsupported";
      detail?: string;
    };
export interface RunOutcome {
  runId: RunId;
  status: Extract<RunStatus, "completed" | "failed" | "timed_out" | "aborted">;
  text?: string;
  error?: ErrorInfo;
  timeoutReason?: TimeoutReason;
  usage?: UsageDelta;
  /** X10: the schema-validated payload submitted via StructuredOutput, once host-side re-validation has also passed. Absent when no schema was requested, or when the run failed(schema). */
  structuredResult?: unknown;
  turns: number;
  durationMs: Millis;
  diag: RunDiagnostics;
  /**
   * G5a: set when persist_snapshot exhausted its durable-retry budget
   * (diag.persistStatus === "degraded_final"). The terminal record itself is
   * never lost (see the fallback JSONL path), but callers must be able to see
   * that the append-entry journal channel did not confirm it landed.
   */
  persistFailed?: boolean;
}
export interface RunDiagnostics {
  createdAt: Millis;
  enqueuedAt?: Millis;
  startedAt?: Millis;
  /** Write-once `phase_entered{prompt_dispatch}` marker (plan §3.5) — written only for `trackInput` runs (W2). */
  promptDispatchedAt?: Millis;
  /** Wake provenance (plan §4.1): write-once, persisted WITHOUT `trigger.claimToken`. Absent unless a wake revive made this run. */
  wakeOrigin?: WakeOrigin;
  /** Effective causal level (plan §3.3 L1): monotonic max, final value carried by the terminal entry. Absent while wake is off. */
  wakeLevel?: number;
  /** Wake-ability verdict written once at admission (wakeOn only); a missing field on an old entry means `legacy_unknown` at revive. */
  wakeExclusion?: WakeExclusion | "none";
  /** First user-message `message_end` of a `trackInput` run (plan §3.5): the linearization point of "input accepted". Write-once. */
  inputAcceptedAt?: Millis;
  /** Proof that pi refused the prompt before accepting it (`trackInput` runs only); write-once. */
  promptOutcome?: "rejected_pre_accept";
  settledAt?: Millis;
  phase: RunPhase;
  phaseEnteredAt: Millis;
  lastEventAt?: Millis;
  lastEventType?: string;
  /**
   * X6b: sticky timestamp of the most recent `turn_start` session event.
   * Unlike lastEventType (which the very next event — message_end of the
   * steered user message, text_delta, tool_start … — overwrites within the
   * same event burst), this is written only on turn_start and survives until
   * the next one, so a 1Hz widget poll can reliably observe "a fresh model
   * turn started after T". Drives mention-note self-clearing (mention/notes.ts).
   */
  lastTurnStartAt?: Millis;
  currentTool?: { name: string; toolCallId: string; startedAt: Millis };
  pendingTools: number;
  turns: number;
  retry?: { attempt: number; maxAttempts: number; delayMs: Millis; startedAt: Millis };
  compacting?: { reason: string; startedAt: Millis };
  /**
   * X9: lifetime accumulator, summed across every `message_end` event seen
   * for this run (including ones observed after the run reached a terminal
   * status, and across compaction — each message_end usage delta is summed
   * exactly once, so it is unaffected by the session's own stats resetting
   * post-compaction). Not derived from SessionHandle.getUsage()/session
   * stats by design (architecture §7.2 X9).
   */
  usage?: UsageDelta;
  /**
   * X12: bounded, deduped set of run ids whose lifetime spend was absorbed
   * into `usage` via a usage-bearing toolResult (nested Agent /
   * get_run_result fetches inside THIS run's session). Cost consumers use
   * it to skip those runs when summing per-run costs (usage broadcast's
   * `absorbed` flag, /agent costs Total). Monotone — ids are only ever added
   * (cap: ABSORBED_RUN_IDS_CAP, FIFO).
   */
  absorbedRunIds?: string[];
  /** Best-effort live context snapshot; trailing events after terminal only update memory and are not persisted again. */
  contextUsage?: ContextUsageInfo;
  /** M-A: display-only spawn metadata (model/label/type), set once at enqueue. */
  model?: { provider: string; id: string };
  /** M-B2 (thinking-level visibility): the child session's effective thinking level
   *  ("off" | "low" | "medium" | "high" | …) after pi's clamping — written by
   *  `session_created` (from `handle.getThinkingLevel?.()`) and updated by
   *  `model_changed` after a set_model switch. Display-only; absent when the
   *  driver exposes no level and on runs persisted before this field shipped. */
  thinkingLevel?: string;
  label?: string;
  /** Display-only raw title (the Agent tool's un-sanitized description), kept only
   *  when it differs from `label`; the web fleet tree renders it as the row's main
   *  title with the label as secondary text. */
  title?: string;
  agentType?: string;
  /** Truncated dispatch prompt for agent-tree pending-row previews and /agent status. */
  taskPrompt?: string;
  /** M-A: bounded ring of observed tool calls (cap: state-machine TOOL_HISTORY_CAP). */
  toolHistory?: ToolCallRecord[];
  /** X1: worktree isolation marker state (display only; see WorktreeDisposition). */
  worktree?: WorktreeDisposition;
  /** Dispatch-time input-budget observations. */
  dispatchMeasure?: DispatchMeasure;
  /** M-A: lifetime per-tool-name counters — unaffected by toolHistory ring eviction. */
  toolCounts?: Record<string, number>;
  /**
   * consult A/B instrumentation plan (§3): mirrors `SpawnRequest.dispatchMeta`
   * verbatim (write-once at enqueue, read-only afterwards). Absent when the
   * dispatcher passed no `meta`, and on any run persisted before this plan
   * shipped (old entries may lack it). Carried through the journal whitelist
   * (D3) so a resume of an interrupted run can inherit it.
   */
  dispatchMeta?: DispatchMeta;
  /**
   * consult A/B instrumentation plan (§4): mirrors `SpawnRequest.schemaPreset`
   * verbatim (write-once at enqueue, read-only afterwards). Absent when the
   * dispatcher's `schema` did not name a known preset, and on any run
   * persisted before this plan shipped (old entries may lack it). Carried
   * through the journal whitelist.
   */
  schemaPreset?: SchemaPresetId;
  stopRequestedAt?: Millis;
  stopCause?: StopCause;
  timeoutReason?: TimeoutReason;
  error?: ErrorInfo;
  escalation: Array<{ level: "L0" | "L1" | "L2" | "L3" | "L3p" | "L4"; at: Millis; ok: boolean; detail?: string }>;
  orphaned: boolean;
  generation: number;
  deadlineAt?: Millis;
  /**
   * Timeout-policy 作为 run 的持久事实（agent-explicit-timeout-extend plan §2.7）：
   * reducer `enqueued` 分支把 input.timeoutPolicy 镜像进来（写一次，此后永不改写）；
   * 随所有持久化面走（终态快照、非终态 journal、tombstone、resume 解析）；resume 继承源；
   * 旧条目（升级前）可缺——读侧对缺席字段走中性文案，不做形状推断。
   */
  timeoutPolicy?: TimeoutPolicy;
  /** hardDeadlineAt 的展示镜像（与 diag.deadlineAt 同款），enqueue 时写一次；spawn-service 终态重建从此处恢复（BL-5）。 */
  hardDeadlineAt?: Millis;
  /** 超时宽限/延长的审计记录；从未发生过时整个字段缺席。 */
  overtime?: {
    /** 进入过几次续跑宽限。 */
    graces: number;
    /** 当前（或终态时最后一次）宽限窗口；被延长救出时删除。终态快照保留它 = 审计痕迹（BL-5）。 */
    grace?: { startedAt: Millis; until: Millis };
    /** 已批准的延长次数。 */
    extensions: number;
    /** 累计实际批准的延长毫秒（可能小于请求量，被天花板夹过）。 */
    grantedMs: Millis;
    /** 最近一次延长的 reason 参数（展示/审计用，截断 200 字符）。 */
    lastReason?: string;
    /** 最近一次延长的来源（v1 只有 "tool"，D-13）。 */
    lastSource?: ExtendSource;
  };
  degraded: Array<{ effect: RunEffect["kind"]; at: Millis; error: string; compensated: boolean }>;
  persistStatus?: "verifying" | "retrying" | "persisted" | "degraded_final";
  staleInputs: number;
  unkillable: Array<{ kind: string; id: string }>;
  deliveryKey?: string;
  lastWarn?: string;
  /**
   * During execution, the text_delta stream preview buffer. On normal
   * prompt_settled, finalText replaces it and sets textFinal; non-normal
   * terminal states retain the accumulated partial output.
   */
  text?: string;
  /** Normal completion has installed the authoritative final assistant text. */
  textFinal?: true;
  /**
   * Display-only tail of the model's in-progress thinking (reasoning) stream
   * for the current turn — the agent tree's `»` preview line. Accumulated
   * from thinking_delta events, hard-capped (state-machine THINKING_TEXT_CAP),
   * and cleared when the turn's answer text starts streaming (text_delta) so
   * the preview falls back to the answer. Never fed back to a model.
   */
  thinkingText?: string;
  /** Persisted pi session used by X2 resume. */
  sessionFile?: string;
  /**
   * bash-timeout-grace plan §3.1/§3.7/§3.8 (P0b, frozen): the runner's
   * end-of-run child bash job snapshot, written exactly once per run by the
   * `exit_facts` session_event branch in reduce() (metadata-only patch, same
   * family as `model` above). Absent when the run had no child registry entry
   * or the feature never fired (e.g. the run never bound a session).
   */
  exitFacts?: RunExitFacts;
  /**
   * fleet-drawer plan §4.1 (review blocker #1): the session leaf id at the
   * run's seal moment, written exactly once per (runId, generation) by the
   * `final_leaf` session_event branch in reduce() (metadata-only patch,
   * same family as `exitFacts` above). Absent when the run never bound a
   * session, the handle/driver does not expose `getLeafId`, or the read
   * threw — consumers must treat absence as the determined `leaf_unknown`
   * error, never guess a fallback leaf.
   */
  finalLeafId?: string;
  /**
   * child-context-switch plan P0 (§2.3.1/§2.4): best-effort diagnostics for
   * the child-session switch_context boundary-draft feature (owned by a
   * later package's turn_end handler/capability state machine — this package
   * only wires the driver mapping + reducer patch + runner settlement).
   * Written by the `context_switch` / `switch_selfcheck_failed` /
   * `switch_capability` session events, same best-effort branch as
   * `contextUsage` above (accepted in every state, no effect, does not
   * touch `lastEventAt`/`lastEventType`).
   */
  contextSwitches?: ContextSwitchDiag;
  /**
   * child-context-switch plan P0 (§2.3.1): bounded ring (cap 3, FIFO) of pi's
   * own automatic-compaction failures observed via `compaction_end{errorMessage}`
   * (non-aborted). The runner's settlement error-message assembly appends the
   * most recent entry's reason/message to a live `turnError` when it postdates
   * both the last successful switch and the last successful pi compaction
   * (`lastCompactionOkAt`) — see runner.ts.
   */
  compactionFailures?: CompactionFailureRecord[];
  /**
   * child-context-switch plan P0 (§2.3.1): timestamp of the most recent
   * non-aborted, non-failed `compaction_end` — i.e. the last time pi's own
   * automatic compaction actually succeeded. Used only to decide whether a
   * `compactionFailures` entry is stale (superseded by a later success).
   */
  lastCompactionOkAt?: Millis;
  /**
   * todo #27 (child-extension-missing diagnostic): set to `true` (never
   * written otherwise — exactOptionalPropertyTypes) when this run's child
   * session never activated pi-toolkit at all — see
   * `src/child/activation-signal.ts` and the `child_extension_missing`
   * DriverEvent above. Absent for every normal run.
   * get_run_result surfaces it via `formatChildExtensionMissing`
   * (src/tools/result-text.ts); the runner also WARNs once per process
   * (dedup'd) the first time it observes the event.
   */
  childExtensionMissing?: true;
  /**
   * 外部 agent（external-agent plan §2.1）：本 run 的外部 provider 运行时元数据
   * （ExternalRunMeta），由 `external_meta` session_event 经 mergeExternalMeta 折入。
   * best-effort 家族（同 contextUsage）：终态后只改 diag 不改已封存的 outcome；
   * pi run 永无此键。随 journal 白名单持久化（run-journal.ts）。
   */
  external?: ExternalRunMeta;
  /**
   * run-persistence plan D4 (§4): present ONLY on the in-memory terminal
   * snapshot that `seedRunStoreFromEntries` synthesizes (via
   * `interruptedFromJournal`, core/run-journal.ts) from a run whose session
   * log holds nothing but non-terminal journal entries — i.e. the run was
   * still in flight when the previous pi process died or its stack was torn
   * down. Never produced by the reducer and never persisted. StopCause stays
   * closed (E19): the precise "restart interrupted" distinction lives here.
   */
  restartInterrupted?: RestartInterruptedInfo;
}
/**
 * run-persistence plan D3: marks a NON-terminal `subagent:run` journal entry
 * (written once at session_created, and at most once more by the
 * session_shutdown flush). Terminal snapshots never carry it.
 */
export interface RunJournalMark {
  kind: "session_created" | "shutdown_flush";
  /** shutdown_flush only: pi's session_shutdown reason ("reload" | "new" | "resume" | "fork" | "quit"). */
  shutdownReason?: string;
}
/** run-persistence plan D4: why a seeded terminal snapshot was synthesized from a journal entry. */
export interface RestartInterruptedInfo {
  /** The journal entry's status (starting/running/stopping/queued). */
  lastStatus: RunStatus;
  lastPhase: RunPhase;
  /** = the journal entry's updatedAt. */
  lastSeenAt: Millis;
  /** The journal entry's mark kind ("session_created" when the entry carries no `journal` field). */
  source: RunJournalMark["kind"];
  shutdownReason?: string;
}
export interface DiagSummary {
  phase: RunPhase;
  status: RunStatus;
  timeoutReason?: TimeoutReason;
  pendingTools: number;
  staleInputs: number;
  degraded: number;
}
export interface LifecycleEvent {
  runId: RunId;
  generation: Generation;
  status: RunStatus;
  at: Millis;
}
export type SendResult = "sent" | "buffered";

export interface DeliveryPayload {
  key: string;
  runId: RunId;
  generation: Generation;
  status: RunOutcome["status"];
  textPreview: string;
  diag: DiagSummary;
  createdAt: Millis;
  reconcileRound: number;
  attempts?: number;
  finalized?: boolean;
  degradedReason?: "pre-finalize" | "policy-error";
  structuredPreview?: string;
  failReason?: string;
  label?: string;
  /** bash-timeout-grace plan §3.7/§3.8 (P0b, frozen): mirrors RunDiagnostics.exitFacts at the moment `finish()` built this payload; same value as outcome.diag.exitFacts / persist_snapshot.snapshot.outcome.diag.exitFacts (P15b). */
  exitFacts?: RunExitFacts;
  /** fabric-cross-session plan §3.7: a wake-revived run's completion notice is quiet (never triggers a turn / mints an ask_user-interrupting token). Absent otherwise. */
  quiet?: true;
}
export interface RunSnapshot {
  runId: RunId;
  generation: Generation;
  status: RunStatus;
  phase: RunPhase;
  deadlines: RunDeadlines;
  diag: RunDiagnostics;
  outcome?: RunOutcome;
  updatedAt: Millis;
  /** Set when the run was spawned as a nested/child run (X3 slotless nesting). */
  parentRunId?: RunId;
  /** run-persistence plan D3: present only on non-terminal journal entries (never on terminal snapshots). */
  journal?: RunJournalMark;
}

export type RunInput =
  | {
      kind: "enqueued";
      at: Millis;
      budget: DeadlineBudget;
      deadlineCapAt?: Millis;
      timeoutPolicy?: TimeoutPolicy;
      meta?: RunDisplayMeta;
    }
  | { kind: "slot_acquired"; at: Millis }
  | { kind: "slot_denied"; at: Millis; reason: "queue_timeout" | "aborted" }
  | { kind: "phase_entered"; at: Millis; phase: RunPhase }
  | {
      kind: "session_created";
      at: Millis;
      sessionId: string;
      sessionFile?: string;
      model?: { provider: string; id: string };
      /** M-B2 (thinking-level visibility): the child session's *effective* thinking
       *  level after pi clamped it (read back via `handle.getThinkingLevel?.()` at
       *  session_created time). Absent when the driver exposes none — old journals
       *  and runs without the field keep loading unchanged. */
      thinking?: string;
    }
  | {
      kind: "startup_failed";
      at: Millis;
      phase: Extract<RunPhase, "resolve_config" | "session_create" | "extension_bind" | "prompt_dispatch">;
      error: ErrorInfo;
    }
  | { kind: "session_event"; at: Millis; event: DriverEvent }
  | { kind: "prompt_settled"; at: Millis; error?: ErrorInfo; text?: string }
  | { kind: "deadline_fired"; at: Millis; timer: TimerId; reason: TimeoutReason }
  | { kind: "stop_requested"; at: Millis; cause: StopCause }
  | { kind: "escalation_done"; at: Millis; level: "L0" | "L1" | "L2" | "L3" | "L3p"; ok: boolean }
  | { kind: "reap_finished"; at: Millis; disposed: boolean; orphaned: boolean }
  | {
      kind: "deadline_extended";
      at: Millis;
      /** 请求追加的毫秒数（叠加在 max(at, deadlineAt) 之上）；由 reducer 负责夹紧。工具层已把 extend_s × 1000。 */
      extendMs: Millis;
      source: ExtendSource;
      reason?: string;
    }
  | { kind: "effect_failed"; at: Millis; effect: RunEffect["kind"]; error: ErrorInfo; timer?: TimerId }
  /**
   * fabric-cross-session plan §4.7 — diag-only inputs (no effect, every non-terminal phase accepts, terminal ignores).
   * Declared by S0 as the shared contract; the reducer branches land in W1 (`wake_level`) and W2 (the other two).
   */
  | { kind: "wake_level"; at: Millis; level: number }
  | { kind: "input_accepted"; at: Millis }
  | { kind: "prompt_rejected"; at: Millis };
export interface StampedInput {
  readonly generation: number;
  readonly input: RunInput;
}
export type RunEffect =
  | { kind: "arm_timer"; timer: TimerId; dueAt: Millis }
  | { kind: "clear_timer"; timer: TimerId }
  | { kind: "cancel_signal"; reason: string }
  | { kind: "soft_steer"; text: string }
  | { kind: "request_abort" }
  | { kind: "dispose" }
  | { kind: "kill_handles" }
  | { kind: "register_orphan"; unkillable: ReadonlyArray<{ kind: string; id: string }> }
  | { kind: "release_slot" }
  | { kind: "settle_waiters"; outcome: RunOutcome }
  | { kind: "emit_lifecycle"; event: LifecycleEvent }
  | { kind: "enqueue_delivery"; payload: DeliveryPayload }
  | { kind: "notify_deadline"; notice: DeadlineNotice }
  | { kind: "persist_snapshot"; snapshot: RunSnapshot }
  /**
   * run-persistence plan D2: best-effort, non-terminal journal entry
   * (session_created). Never enters the in-memory SnapshotStore (J1) — the
   * adapter only appends it to the session log (J2), synchronously and
   * never throwing (J7).
   */
  | { kind: "journal_snapshot"; snapshot: RunSnapshot };
export interface EffectEnvelope {
  readonly effectId: string;
  readonly effect: RunEffect;
  readonly criticality: "critical" | "best_effort";
}
export interface RunState {
  /** Runner-only input evidence opt-in (fabric wake); omitted when wake is off. Never journaled. */
  readonly trackInput?: true;
  readonly runId: RunId;
  readonly generation: number;
  readonly status: RunStatus;
  readonly phase: RunPhase;
  readonly deadlines: RunDeadlines;
  readonly diag: RunDiagnostics;
  readonly armedTimers: readonly TimerId[];
  readonly slotHeld: boolean;
  readonly sessionId?: string;
  readonly outcome?: RunOutcome;
  readonly effectSeq: number;
  readonly persistRetryCount: number;
  readonly parentRunId?: RunId;
}

// ── Canonical shapes shared across runtime/service adapters (single source of
// truth; downstream modules import these instead of redeclaring them) ──

/**
 * Input to SessionDriver.create(): the minimal, pi-shaped session
 * configuration. This is the *execution-layer* spec (what the driver needs to
 * start a session) — distinct from the service-layer RunnerSpec
 * (service/ports.ts), which additionally carries the resolved AgentTypeConfig,
 * the original SpawnRequest and the DeadlineBudget.
 */
export interface SessionSpec {
  cwd?: string;
  agentDir?: string;
  model?: unknown;
  thinkingLevel?: string;
  tools?: string[];
  excludeTools?: string[];
  noTools?: "all" | "builtin";
  prompt?: string;
  /**
   * workflow-worktree plan D9 (only-read linkPaths note): extra prose an H2
   * extension wants appended to the actual model-facing prompt. NOT a
   * SessionSpec field the driver ever sees — runtime-adapter.ts strips it
   * out before building the driver request and folds it into the prompt via
   * `appendPromptNotes(buildPrompt(spec), promptNotes)` instead (the plain
   * `prompt` field on this interface is otherwise always overridden by the
   * request's own `prompt`, see runtime-adapter.ts's `buildPrompt`).
   */
  promptNotes?: readonly string[];
  /** Whether a fresh session must be persisted for later resume. */
  persist?: boolean;
  /** Existing session file to open for X2 resume. */
  resumeFrom?: string;
  /**
   * Additional tool definitions to register for this session (pi's
   * `createAgentSession({ customTools })`, see 2.9). Typed `unknown[]` here
   * (not `ToolDefinition[]`) to keep core/types.ts free of
   * `@earendil-works/*` imports (I1); the driver casts at the point of use
   * (matches the existing `model?: unknown` convention on this interface).
   * X3 (nested Agent tool) and X10 (StructuredOutput tool) are injected this
   * way by service/runtime-adapter.ts before H2 extensions run.
   */
  customTools?: unknown[];
  /**
   * 外部 agent（external-agent plan §2.1，冻结面）：存在即由 RoutingSessionDriver
   * 交给外部 provider；PiSessionDriver 永不读取。
   */
  external?: ExternalRunSpec;
  /**
   * `prompt_mode: replace` agent types: the type's system prompt, which
   * replaces pi's base system prompt (preamble / tool list / rules / docs).
   * pi still appends APPEND_SYSTEM, project context files (AGENTS.md),
   * skills and cwd — the same semantics as `pi --system-prompt`. Applied by
   * the driver through `DefaultResourceLoader({ systemPromptOverride })`.
   * Absent for `append` types (their prompt is prefixed to the task prompt).
   */
  systemPrompt?: string;
}

/** A resource an injected tool holds that reaper can synchronously, idempotently kill (2.2.2). */
export interface KillableHandle {
  readonly kind: "process" | "socket" | "fd" | "timer";
  readonly id: string;
  kill(): void;
}

/** L4 registry entry for a run whose physical resources could not be fully reclaimed (4.3.2). */
export interface OrphanRecord {
  runId: RunId;
  sessionId?: string;
  phase: RunPhase;
  reason: TimeoutReason | StopCause;
  lastEventAt?: Millis;
  registeredAt: Millis;
  unkillable: Array<{ kind: string; id: string }>;
  lateArrival: boolean;
}

/**
 * The four documented extension hooks (architecture §7.1). Only-read observer
 * (onLifecycle/onDelivery) and bounded pre/post hooks (resolveSessionSpec/
 * beforeReap). Not deeply wired in M1; the index.ts assembly forwards
 * onLifecycle today, the rest are reserved extension points for later
 * milestones (X1/X3/X9 etc.).
 */
export interface SubagentExtensionPoints {
  onLifecycle?(e: LifecycleEvent): void;
  /**
   * workflow-worktree plan D12 (v2.1 condition 1): `ctx.signal` is aborted by
   * the adapter when its startupMs-scale wrapper (withStartupTimeout) gives
   * up on this hook — the hook is expected to check it around/after its own
   * long-running steps (git commands) and unwind. Old extensions that don't
   * declare the third parameter never see it and keep running to completion
   * exactly as before (their leak, if any, is caught by `abandonSessionSpec`
   * below instead).
   */
  resolveSessionSpec?(
    spec: SessionSpec,
    req: SpawnRequest,
    ctx?: { signal: AbortSignal },
  ): Promise<SessionSpec> | SessionSpec;
  /**
   * workflow-worktree plan D12: fired (fire-and-forget by the adapter, never
   * awaited) when `resolveSessionSpec` ran on this runId but the runner was
   * never entered afterwards — startup timeout, the hook itself throwing, a
   * later extension in the chain throwing, or a synchronous throw between H2
   * succeeding and the runner starting. Extensions that created a resource in
   * `resolveSessionSpec` (the worktree) use this to compensate (best-effort,
   * bounded, never awaited by the caller). Extensions without state to clean
   * up simply omit this method.
   */
  abandonSessionSpec?(
    runId: RunId,
    ctx: { reason: "startup_timeout" | "h2_failed" | "pre_runner_exit" },
  ): Promise<void> | void;
  beforeReap?(
    outcome: RunOutcome,
    ctx: {
      cwd: string;
      deadlineMs: Millis;
      /**
       * X1: post-settlement display-state write-back (worktree disposal
       * outcome → diag.worktree). Best-effort: absent in tests/legacy wiring,
       * and it must never influence the run outcome itself.
       */
      setWorktreeDisposition?(disposition: WorktreeDisposal): void;
    },
  ): Promise<void> | void;
  onDelivery?(p: DeliveryPayload, state: string): void;
}
