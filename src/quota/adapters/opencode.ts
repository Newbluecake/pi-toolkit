/**
 * OpenCode Go subscription adapter (opencode-go) — docs/dev/quota/README.md。
 * 端点契约（2026-11-03 主会话用真实 key 实测，HTTP 200）：
 *
 * - `GET {baseUrl}/zen/go/v1/usage`（默认 https://opencode.ai），
 *   `Authorization: Bearer <key>`（auth.json 的 opencode-go）。
 * - 响应：`{"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"ISO"},
 *   "weekly":{…},"monthly":{…}}}` —— rolling ⇒ scope "5h"，weekly ⇒ "week"，
 *   monthly ⇒ "month"；`percent` 是已用百分比（0..100，解析层 clamp），
 *   `resetsAt` ISO 串 ⇒ resetAt（epoch ms）。
 * - 三窗口独立解析：某一格形状不符只丢那一格；一格都解析不出 ⇒ undefined。
 *   全 typeof 守卫；任何异常返回 undefined，绝不抛（静默降级契约）。
 */

import type { Millis } from "../../core/types.js";
import type { QuotaWindow, QuotaWindowsSnapshot } from "../types.js";
import type { AdapterDeps, QuotaAdapter } from "./types.js";
import { clampPercent, finiteNumber, isRecord } from "./types.js";

export const OPENCODE_GO_USAGE_PATH = "/zen/go/v1/usage";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai";

/** ISO 串 → epoch ms；非串 / 空串 / 不可解析 → undefined。 */
function parseIsoMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** 一格（rolling/weekly/monthly）→ QuotaWindow；非 record / percent 非有限数字 ⇒ undefined。 */
function parseEntry(entry: unknown, scope: QuotaWindow["scope"]): QuotaWindow | undefined {
  if (!isRecord(entry)) return undefined;
  const percent = finiteNumber(entry.percent);
  if (percent === undefined) return undefined;
  const resetAt = parseIsoMs(entry.resetsAt);
  return {
    scope,
    usedPct: Math.round(clampPercent(percent)),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

/** 全 typeof 守卫；任何形状异常返回 undefined，不抛（静默降级契约）。 */
export function parseOpencodeGoQuota(raw: unknown, now: Millis): QuotaWindowsSnapshot | undefined {
  if (!isRecord(raw)) return undefined;
  const usage = raw.usage;
  if (!isRecord(usage)) return undefined;
  const entries: readonly (readonly [string, QuotaWindow["scope"]])[] = [
    ["rolling", "5h"],
    ["weekly", "week"],
    ["monthly", "month"],
  ];
  const windows: QuotaWindow[] = [];
  for (const [key, scope] of entries) {
    const window = parseEntry(usage[key], scope);
    if (window !== undefined) windows.push(window);
  }
  if (windows.length === 0) return undefined;
  return { provider: "opencode-go", kind: "windows", windows, fetchedAt: now };
}

export const opencodeGoAdapter: QuotaAdapter = {
  id: "opencode-go",
  kind: "windows",
  defaultBaseUrl: OPENCODE_GO_BASE_URL,
  fetchQuota: async (deps: AdapterDeps) => {
    try {
      if (typeof deps.apiKey !== "string" || deps.apiKey === "") return undefined; // 无 key 不发请求
      const raw = await deps.fetchJson(`${deps.baseUrl}${OPENCODE_GO_USAGE_PATH}`, {
        headers: {
          Authorization: `Bearer ${deps.apiKey}`,
          ...(deps.userAgent === "" ? {} : { "User-Agent": deps.userAgent }),
        },
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      return parseOpencodeGoQuota(raw, deps.now());
    } catch {
      return undefined; // fetchJson 契约永不抛；此 catch 兜注入桩异常——绝不抛
    }
  },
};
