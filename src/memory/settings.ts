/**
 * memory · settings (#56 batch 2 ⑧): the `memory` block's types, frozen defaults and never-throws parser
 * (cwd-keyed project memory; tidy batch limits come from `./tidy/batch-settings.ts`). `src/config/settings.ts`
 * imports ONLY this module for the block.
 */
import {
  DEFAULT_TIDY_BATCH_SETTINGS,
  resolveTidyBatchSettings,
  type TidyBatchSettings,
} from "./tidy/batch-settings.js";

/**
 * Merged armory-memory (memory-plan §3.1): cwd-keyed project memory under
 * `~/.pi/agent/memory/<slug>/` — auto-injection, the `memory` tool, `/mem`.
 * Field-by-field tolerant parsing in `parseMemorySettings` (never throws,
 * parseBashJobsSettings 同款风格）。Duration fields (file stores integer
 * seconds, converted at the `*S ⇄ *Ms` boundary): `jev.confirmTimeoutMs`
 * (seconds key `memory.jev.confirmTimeoutS`) and `jev.recall.waitMs`
 * (seconds key `memory.jev.recall.waitS`, Q37), both registered in
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
  /** Jev 核心 memory：jev-plan v2 §4 J3 / jev-arch §9.1. */
  jev: MemoryJevSettings;
}

/** 17 个 `memory.jev.*` 设置键（jev-arch §9.1 原 14 + 2026-11-03 噪音修复的 fastPath×3；`classifiersRejected` 不是设置键，只是解析结果）。 */
export interface MemoryJevSettings {
  /** 总开关。false ⇒ 不接线 Jev（零注册）。Default true（Q27：有可用凭证即启用）；legacy/secure 域强制视为 false。 */
  enabled: boolean;
  /** provider/id 有序列表，去重保序，逗号串或字符串数组均可。Default
   *  ["opencode/jev-1.13-free", "opencode/jev-1.13"]（arch §5.2；openrouter 项留给独立改动 E1）。
   *  空列表（或非空但全部非法）⇒ 等同 enabled=false（Q34，off(empty-list)），零调用部分也不生效。 */
  classifiers: string[];
  /** 解析时丢弃的非法 classifiers 原文（≤10 项、每项 ≤80 码点），只供 doctor/启动提醒展示，不是独立设置键。Default []。 */
  classifiersRejected: string[];
  /** 专用代理地址，"" = 不传 fetch。Default ""。 */
  proxy: string;
  /** 子会话是否接线 Jev（召回 + 门禁）。Default true。 */
  childSessions: boolean;
  recall: {
    /** 召回判定阈值。Default 0.6（主会话按 E0 基线评测拍板改自原架构稿 0.7；门禁阈值仍 0.6 不变）；0.5–0.99。 */
    threshold: number;
    /** 单次注入条目数上限。Default 3；1–10（E 层固定为 2，arch §9.1）。 */
    maxEntries: number;
    /** 单次注入字节预算。Default 4096；512–16384。 */
    maxBytes: number;
    /** 同步等待上限（ms）；文件键按秒存 `recall.waitS`（TIME_SETTING_MS_PATHS）。Default 2000（Q37，原 1500）；0–3000（0 = 纯异步，Q25）。 */
    waitMs: number;
  };
  gate: {
    /** 门禁总开关。Default true。 */
    enabled: boolean;
    /** 门禁判定阈值。Default 0.6；0.5–0.95。 */
    threshold: number;
  };
  review: {
    /** 整理复审间隔天数，0 = 只能手动。Default 7（Q31）；0–90。 */
    intervalDays: number;
  };
  /** 单次 activation 的 Jev 调用总美元预算。Default 0.5；0.01–5。 */
  maxCostUsd: number;
  /** 单次 activation 的 Jev 调用总次数上限。Default 800；0–5000。 */
  maxCalls: number;
  /** 写路径确认超时（ms）；文件键按秒存 `confirmTimeoutS`（TIME_SETTING_MS_PATHS）。Default 60_000；10_000–600_000。 */
  confirmTimeoutMs: number;
  /** A 层快速通道加白标签（默认只有 risk:"high" 标签能触发 A 注入；2026-11-03 噪音修复）。CSV 或数组，非法 id 静默丢弃。Default []。 */
  fastPathAllowTags: string[];
  /** A 层快速通道黑名单标签（优先于高危/加白判定）。Default []。 */
  fastPathDenyTags: string[];
  /** A 层同条目跨会话冷却（小时），0 = 关闭（U 层判定不受限）。Default 24；0–720。 */
  fastPathCooldownH: number;
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

/** `memory.jev.classifiers` 必须匹配 `provider/id`（斜杠两侧均非空白、无空白字符）；否则记进 `classifiersRejected`（J3，Q34）。 */
const JEV_CLASSIFIER_RE = /^[^/\s]+\/\S+$/;
const JEV_CLASSIFIERS_REJECTED_MAX = 10;
const JEV_CLASSIFIERS_REJECTED_ITEM_MAX_CODEPOINTS = 80;

function truncateCodepoints(s: string, max: number): string {
  const codepoints = Array.from(s);
  return codepoints.length <= max ? s : codepoints.slice(0, max).join("");
}

const JEV_TAG_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** CSV/数组 ⇒ 合法 tag id 列表（去重保序；非法 id 静默丢弃——标签名单不是凭证，拼错不值得启动提醒）。 */
function parseJevTagIdList(raw: unknown): string[] {
  const out: string[] = [];
  for (const token of splitJevClassifiersCsv(raw)) {
    if (JEV_TAG_ID_RE.test(token) && !out.includes(token)) out.push(token);
  }
  return out;
}

/** 逗号串或字符串数组 ⇒ 逐项 trim 后的非空 token 列表（webHub.lan 同款 CSV 解析风格）。 */
function splitJevClassifiersCsv(raw: unknown): string[] {
  const parts =
    typeof raw === "string"
      ? raw.split(",")
      : Array.isArray(raw)
        ? raw.flatMap((item) => (typeof item === "string" ? item.split(",") : []))
        : [];
  return parts.map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * Q34：`raw` 缺失 ⇒ 落回默认列表（`classifiersRejected` 清空）；`raw` 是字符串/数组（含 "" 和 []，
 * 即显式表达“关闭”）⇒ 逐项校验，合法项去重保序进 `classifiers`，非法项（去重前，上限 10 项、每项截断
 * 80 码点）进 `classifiersRejected`；`raw` 是其它类型（数字/布尔/对象等，视为配置错误而非故意置空）⇒
 * 同样落回默认列表。全部非法或本就为空 ⇒ `classifiers` 为空列表（= off，由 wireMemory 消费）。
 */
function parseJevClassifiers(
  raw: unknown,
  fallback: { classifiers: readonly string[] },
): { classifiers: string[]; classifiersRejected: string[] } {
  if (raw === undefined || (typeof raw !== "string" && !Array.isArray(raw))) {
    return { classifiers: [...fallback.classifiers], classifiersRejected: [] };
  }
  const classifiers: string[] = [];
  const classifiersRejected: string[] = [];
  for (const token of splitJevClassifiersCsv(raw)) {
    if (JEV_CLASSIFIER_RE.test(token)) {
      if (!classifiers.includes(token)) classifiers.push(token);
    } else if (classifiersRejected.length < JEV_CLASSIFIERS_REJECTED_MAX) {
      classifiersRejected.push(truncateCodepoints(token, JEV_CLASSIFIERS_REJECTED_ITEM_MAX_CODEPOINTS));
    }
  }
  return { classifiers, classifiersRejected };
}

/**
 * Parse the optional `memory` settings block (memory-plan §3.2). Malformed or
 * missing input falls back field-by-field to DEFAULT_MEMORY_SETTINGS; never
 * throws (parseBashJobsSettings 同款）。Numbers must be finite and inside
 * their documented range; `maxWriteBytes` is additionally clamped to
 * ≤ maxFileBytes so a single write can never exceed the per-file cap.
 */
export function parseMemorySettings(input: unknown): MemorySettings {
  const defaults = DEFAULT_MEMORY_SETTINGS;
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

  const jevRaw = value.jev;
  const jevObj: Record<string, unknown> =
    jevRaw && typeof jevRaw === "object" && !Array.isArray(jevRaw) ? (jevRaw as Record<string, unknown>) : {};
  const { classifiers: jevClassifiers, classifiersRejected: jevClassifiersRejected } = parseJevClassifiers(
    jevObj.classifiers,
    defaults.jev,
  );
  const jevRecallRaw = jevObj.recall;
  const jevRecallObj: Record<string, unknown> =
    jevRecallRaw && typeof jevRecallRaw === "object" && !Array.isArray(jevRecallRaw)
      ? (jevRecallRaw as Record<string, unknown>)
      : {};
  const jevGateRaw = jevObj.gate;
  const jevGateObj: Record<string, unknown> =
    jevGateRaw && typeof jevGateRaw === "object" && !Array.isArray(jevGateRaw)
      ? (jevGateRaw as Record<string, unknown>)
      : {};
  const jevReviewRaw = jevObj.review;
  const jevReviewObj: Record<string, unknown> =
    jevReviewRaw && typeof jevReviewRaw === "object" && !Array.isArray(jevReviewRaw)
      ? (jevReviewRaw as Record<string, unknown>)
      : {};
  const jev: MemoryJevSettings = {
    enabled: bool(jevObj.enabled, defaults.jev.enabled),
    classifiers: jevClassifiers,
    classifiersRejected: jevClassifiersRejected,
    proxy: typeof jevObj.proxy === "string" ? jevObj.proxy : defaults.jev.proxy,
    childSessions: bool(jevObj.childSessions, defaults.jev.childSessions),
    recall: {
      threshold: numFloat(jevRecallObj.threshold, defaults.jev.recall.threshold, 0.5, 0.99),
      maxEntries: num(jevRecallObj.maxEntries, defaults.jev.recall.maxEntries, 1, 10),
      maxBytes: num(jevRecallObj.maxBytes, defaults.jev.recall.maxBytes, 512, 16384),
      waitMs: num(jevRecallObj.waitMs, defaults.jev.recall.waitMs, 0, 3000),
    },
    gate: {
      enabled: bool(jevGateObj.enabled, defaults.jev.gate.enabled),
      threshold: numFloat(jevGateObj.threshold, defaults.jev.gate.threshold, 0.5, 0.95),
    },
    review: {
      intervalDays: num(jevReviewObj.intervalDays, defaults.jev.review.intervalDays, 0, 90),
    },
    maxCostUsd: numFloat(jevObj.maxCostUsd, defaults.jev.maxCostUsd, 0.01, 5),
    maxCalls: num(jevObj.maxCalls, defaults.jev.maxCalls, 0, 5000),
    confirmTimeoutMs: num(jevObj.confirmTimeoutMs, defaults.jev.confirmTimeoutMs, 10_000, 600_000),
    fastPathAllowTags: parseJevTagIdList(jevObj.fastPathAllowTags),
    fastPathDenyTags: parseJevTagIdList(jevObj.fastPathDenyTags),
    fastPathCooldownH: num(jevObj.fastPathCooldownH, defaults.jev.fastPathCooldownH, 0, 720),
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
    jev,
  };
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
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
  jev: {
    enabled: true,
    classifiers: ["opencode/jev-1.13-free", "opencode/jev-1.13"],
    classifiersRejected: [],
    proxy: "",
    childSessions: true,
    recall: { threshold: 0.6, maxEntries: 3, maxBytes: 4096, waitMs: 2000 },
    gate: { enabled: true, threshold: 0.6 },
    review: { intervalDays: 7 },
    maxCostUsd: 0.5,
    maxCalls: 800,
    confirmTimeoutMs: 60_000,
    fastPathAllowTags: [],
    fastPathDenyTags: [],
    fastPathCooldownH: 24,
  },
};
