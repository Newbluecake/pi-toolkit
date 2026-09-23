/**
 * Kimi Code subscription adapter (kimi-coding, CN 站) — docs/dev/quota/
 * quota-plan.md §3.7, external contract in quota-requirements.md「已验证的外部
 * 契约」.
 *
 * - `GET {baseUrl}/coding/v1/usages`（默认 https://api.kimi.com；海外站
 *   api.kimi.ai 未实测，首版不挂——settings 的 baseUrl 是逃生阀）。
 * - 认证：`Authorization: Bearer <key>`，**且必须带浏览器 User-Agent**——
 *   裸 curl/node UA 会被 Cloudflare 拦（实测 403 error 1010）。deps.userAgent
 *   为空时回落 http.ts 的 DEFAULT_USER_AGENT。
 * - 解析优先级：顶层 `usages.limit_5h` / `usages.limit_7d`（used_ratio 0..1
 *   浮点 + ISO reset_time，最规整）> 兜底路径（顶层 `usage` → week、
 *   `limits[].detail` → 5h，字符串数字）。usages 产出 ≥1 个窗口时**只用**
 *   usages（两者矛盾时以 usages 为准）。
 * - **不读 `totalQuota`**：上游 bug（MoonshotAI/kimi-code#1569）该字段恒为
 *   99，只用 ratio。
 * - 周耗尽陷阱：周窗口 used_ratio:1 时 5h 可能仍 remaining:100——本层只负责
 *   如实产出两个窗口，provider 级取最高严重级是 ladder 的职责。
 */

import { DEFAULT_USER_AGENT } from "../http.js";
import type { Millis } from "../../core/types.js";
import type { QuotaWindow, QuotaWindowsSnapshot } from "../types.js";
import type { AdapterDeps, QuotaAdapter } from "./types.js";
import { clampPercent, finiteNumber, isRecord } from "./types.js";

export const KIMI_USAGES_PATH = "/coding/v1/usages";
export const KIMI_BASE_URL = "https://api.kimi.com";

/** ISO 串 → epoch ms；非串 / 不可解析 → undefined。 */
function parseIsoMs(value: unknown): Millis | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** 字符串数字或数字 → 有限 number（Kimi 的兜底字段是 "100" 这类字符串）。 */
function parseLooseNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function windowOf(scope: QuotaWindow["scope"], usedPct: number, resetAt: Millis | undefined): QuotaWindow {
  return {
    scope,
    usedPct: Math.round(clampPercent(usedPct)),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

/** 首选路径：usages.limit_5h / limit_7d（used_ratio 0..1 × 100，clamp 到 0..100）。 */
function parseUsages(usages: unknown): QuotaWindow[] {
  if (!isRecord(usages)) return [];
  const windows: QuotaWindow[] = [];
  const entries: readonly (readonly [string, QuotaWindow["scope"]])[] = [
    ["limit_5h", "5h"],
    ["limit_7d", "week"],
  ];
  for (const [key, scope] of entries) {
    const entry = usages[key];
    if (!isRecord(entry)) continue;
    const ratio = finiteNumber(entry.used_ratio);
    if (ratio === undefined) continue;
    windows.push(windowOf(scope, ratio * 100, parseIsoMs(entry.reset_time)));
  }
  return windows;
}

/** 兜底路径：顶层 usage（week，used/limit）+ limits[].detail（5h，(limit-remaining)/limit）。 */
function parseLegacy(raw: Record<string, unknown>): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const limits = raw.limits;
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      if (!isRecord(entry)) continue;
      const window = entry.window;
      const detail = entry.detail;
      if (!isRecord(window) || !isRecord(detail)) continue;
      const duration = finiteNumber(window.duration);
      if (duration !== 300 || window.timeUnit !== "TIME_UNIT_MINUTE") continue; // 300 分钟 = 5h
      const limit = parseLooseNumber(detail.limit);
      const remaining = parseLooseNumber(detail.remaining);
      if (limit === undefined || limit <= 0 || remaining === undefined) continue;
      windows.push(windowOf("5h", ((limit - remaining) / limit) * 100, parseIsoMs(detail.resetTime)));
    }
  }
  const usage = raw.usage;
  if (isRecord(usage)) {
    const limit = parseLooseNumber(usage.limit);
    const used = parseLooseNumber(usage.used);
    if (limit !== undefined && limit > 0 && used !== undefined) {
      windows.push(windowOf("week", (used / limit) * 100, parseIsoMs(usage.resetTime)));
    }
  }
  return windows;
}

/** 全 typeof 守卫；任何形状异常返回 undefined，不抛（静默降级契约）。 */
export function parseKimiQuota(raw: unknown, now: Millis): QuotaWindowsSnapshot | undefined {
  if (!isRecord(raw)) return undefined;
  // totalQuota 刻意不读（上游 bug 恒为 99，MoonshotAI/kimi-code#1569）。
  const windows = parseUsages(raw.usages);
  if (windows.length > 0) {
    return { provider: "kimi-coding", kind: "windows", windows, fetchedAt: now };
  }
  const legacy = parseLegacy(raw);
  if (legacy.length === 0) return undefined;
  return { provider: "kimi-coding", kind: "windows", windows: legacy, fetchedAt: now };
}

export const kimiAdapter: QuotaAdapter = {
  id: "kimi-coding",
  kind: "windows",
  defaultBaseUrl: KIMI_BASE_URL,
  fetchQuota: async (deps: AdapterDeps) => {
    try {
      if (typeof deps.apiKey !== "string" || deps.apiKey === "") return undefined; // 无 key 不发请求
      const userAgent = deps.userAgent === "" ? DEFAULT_USER_AGENT : deps.userAgent;
      const raw = await deps.fetchJson(`${deps.baseUrl}${KIMI_USAGES_PATH}`, {
        headers: {
          Authorization: `Bearer ${deps.apiKey}`,
          "User-Agent": userAgent, // Cloudflare 1010 回归防护
        },
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      return parseKimiQuota(raw, deps.now());
    } catch {
      return undefined; // fetchJson 契约永不抛；此 catch 兜注入桩异常——绝不抛
    }
  },
};
