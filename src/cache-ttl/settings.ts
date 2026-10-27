/**
 * cache-ttl · settings (#56 batch 2 ⑧): the `cacheTtl` block's type, frozen defaults and never-throws parser.
 * `src/config/settings.ts` imports ONLY this module for the block, so the aggregator no longer reaches into
 * `keepalive-state` itself (the `config → cache-ttl/keepalive-state` value edge now lives here, inside cache-ttl).
 */
import { MAX_SAFE_KEEPALIVE_INTERVAL_MS } from "./keepalive-state.js";

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

/** Parse the optional Anthropic prompt-cache TTL settings block. Field-by-field tolerant (parseMemorySettings 同款 bool()/num() helpers), never throws. */
export function parseCacheTtlSettings(input: unknown): CacheTtlSettings {
  const defaults = DEFAULT_CACHE_TTL_SETTINGS;
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

export const DEFAULT_CACHE_TTL_SETTINGS: CacheTtlSettings = {
  mode: "auto",
  keepalive: true,
  keepaliveIntervalMs: 240_000,
  keepaliveMinPrefixTokens: 20_000,
  childKeepalive: true,
  childKeepaliveMaxPingsPerRun: 24,
  childKeepaliveMaxConcurrent: 4,
  childKeepaliveRunBudgetUsd: 1.5,
  childKeepaliveProcessBudgetUsd: 10,
};
