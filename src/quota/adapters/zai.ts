/**
 * GLM Coding Plan adapter (zai-coding-cn / zai) — docs/dev/quota/quota-plan.md
 * §3.7, external contract in quota-requirements.md「已验证的外部契约」.
 *
 * - `GET {baseUrl}/api/monitor/usage/quota/limit`（国内 open.bigmodel.cn /
 *   海外 api.z.ai，同 key 同数据）；国内 / 海外只差 id 与默认 baseUrl，
 *   解析器完全共用。
 * - 认证：`Authorization` 放**裸 key**（无 `Bearer ` 前缀——实测如此）。
 * - `unit:3` ⇒ 5h 窗口、`unit:6` ⇒ 周窗口，其余 unit 静默跳过；
 *   `nextResetTime` 是毫秒 epoch。
 * - `usedPct` **优先自算** `currentValue/usage*100`（取整）；`percentage`
 *   只在 usage <= 0（或 currentValue 不可用）时兜底——实测样例里
 *   percentage=1 与自算 0.28 不一致，自算才是权威。
 * - 团队版 `?type=2` + `bigmodel-organization` 头本期不做（接口留扩展位）。
 */

import { DEFAULT_USER_AGENT } from "../http.js";
import type { Millis } from "../../core/types.js";
import type { QuotaProviderId, QuotaWindow, QuotaWindowsSnapshot, WindowScope } from "../types.js";
import type { AdapterDeps, QuotaAdapter } from "./types.js";
import { clampPercent, finiteNumber, isRecord } from "./types.js";

export const ZAI_QUOTA_PATH = "/api/monitor/usage/quota/limit";
export const ZAI_CN_BASE_URL = "https://open.bigmodel.cn";
export const ZAI_OVERSEAS_BASE_URL = "https://api.z.ai";

/** unit:3 ⇒ "5h"，unit:6 ⇒ "week"，其余 undefined（调用方静默跳过）。 */
export function zaiScopeOfUnit(unit: unknown): WindowScope | undefined {
  if (unit === 3) return "5h";
  if (unit === 6) return "week";
  return undefined;
}

/** 全 typeof 守卫；任何形状异常返回 undefined，不抛（静默降级契约）。 */
export function parseZaiQuota(raw: unknown, provider: QuotaProviderId, now: Millis): QuotaWindowsSnapshot | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.code !== 200) return undefined;
  const data = raw.data;
  if (!isRecord(data)) return undefined;
  const limits = data.limits;
  if (!Array.isArray(limits)) return undefined;
  const windows: QuotaWindow[] = [];
  for (const entry of limits) {
    if (!isRecord(entry)) continue;
    const scope = zaiScopeOfUnit(entry.unit);
    if (scope === undefined) continue; // 未知 unit：静默跳过，其余保留
    const usage = finiteNumber(entry.usage);
    const currentValue = finiteNumber(entry.currentValue);
    const percentage = finiteNumber(entry.percentage);
    let usedPct: number | undefined;
    if (usage !== undefined && usage > 0 && currentValue !== undefined) {
      usedPct = (currentValue / usage) * 100; // 自算优先（实测权威）
    } else if (percentage !== undefined) {
      usedPct = percentage; // 兜底：GLM 自己的整数百分比
    }
    if (usedPct === undefined) continue;
    const resetAt = finiteNumber(entry.nextResetTime);
    windows.push({
      scope,
      usedPct: Math.round(clampPercent(usedPct)),
      ...(resetAt === undefined ? {} : { resetAt: Math.round(resetAt) }),
    });
  }
  if (windows.length === 0) return undefined; // 无可用窗口 = 无快照，不是空快照
  const level = data.level;
  const plan = typeof level === "string" && level !== "" ? level : undefined;
  return {
    provider,
    kind: "windows",
    windows,
    fetchedAt: now,
    ...(plan === undefined ? {} : { plan }),
  };
}

function makeZaiAdapter(id: QuotaProviderId, defaultBaseUrl: string): QuotaAdapter {
  return {
    id,
    kind: "windows",
    defaultBaseUrl,
    fetchQuota: async (deps: AdapterDeps) => {
      try {
        if (typeof deps.apiKey !== "string" || deps.apiKey === "") return undefined; // 无 key 不发请求
        const userAgent = deps.userAgent === "" ? DEFAULT_USER_AGENT : deps.userAgent;
        const raw = await deps.fetchJson(`${deps.baseUrl}${ZAI_QUOTA_PATH}`, {
          headers: {
            Authorization: deps.apiKey, // 裸 key，无 Bearer 前缀（实测契约）
            "User-Agent": userAgent,
          },
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        });
        return parseZaiQuota(raw, id, deps.now());
      } catch {
        return undefined; // fetchJson 契约永不抛；此 catch 兜注入桩异常——绝不抛
      }
    },
  };
}

export const zaiAdapter: QuotaAdapter = makeZaiAdapter("zai-coding-cn", ZAI_CN_BASE_URL);
export const zaiOverseasAdapter: QuotaAdapter = makeZaiAdapter("zai", ZAI_OVERSEAS_BASE_URL);
