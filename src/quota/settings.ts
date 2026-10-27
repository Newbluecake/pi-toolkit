/**
 * quota · settings (#56 batch 2 ⑧): the `quota` block's types, frozen defaults and never-throws parsers.
 * `src/config/settings.ts` imports ONLY this module for the block. Type-only import of `./types.js`
 * (zero-pi domain shapes), so the aggregator has no runtime dependency on the quota module graph.
 */
import type { QuotaPoolId, WindowScope } from "./types.js";

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
 * Parse the optional `quota` settings block (quota-plan §8.3). Field-by-field
 * tolerant (parseCacheTtlSettings 同款 bool()/num() 手法), never throws.
 * Threshold monotonicity is clamped (l1 <= l2 <= l3 — a config written backwards
 * is pushed up, not silently ignored); `providers` keeps empty strings (empty
 * = all providers off); base URLs must be http(s) and lose trailing slashes.
 */
export function parseQuotaSettings(input: unknown): QuotaSettings {
  const defaults = DEFAULT_QUOTA_SETTINGS;
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

export const DEFAULT_QUOTA_SETTINGS: QuotaSettings = {
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
};
