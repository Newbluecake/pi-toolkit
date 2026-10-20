/**
 * Factory droid adapter pair (docs/dev/external-agent/quota-plan.md r2 §3): one
 * GET `/api/billing/limits` yields TWO pool snapshots — `droid-standard` and
 * `droid-core` — sharing the same in-flight request.
 *
 * - 认证：`Authorization: Bearer <FACTORY_API_KEY>`（与 droid 子进程继承同一把
 *   key，D3 拍板；不读 ~/.factory/env.sh）。无 key ⇒ 不发请求。
 * - 一个适配器对子负责两个池：`inflight` / `last` 住在 pair 闭包里（**不放模块级
 *   状态**，/reload 安全）；第二个适配器复用第一个的在途 promise（5s 合并窗口，
 *   D21 频率由 service 的 TTL 驱动）。**`inflight` 在 `fetchQuota` 的第一个
 *   await 之前同步赋值**（评审核查项 1）：service 在同一 refresh pass 里串行调用
 *   两个适配器，第二个必须能同步看到第一个的在途 promise。
 * - 时间只用 `deps.now()`，零计时器。
 * - 认证问题（401/402/403，K3 实测 402 是「旧 key」现场）：不产快照 + 可选健康端口
 *   通知（2026-10-20：provider 统一不可用闸门）+ 按状态码 warnOnce（文案不含 key）+ `lastProblem` 供
 *   HUD `droid auth <code>`；解析成功 ⇒ 清除。
 * - 解析（K4 语义归一化）：`active = resetAt !== undefined && resetAt > now`；
 *   未激活窗口记 0%、不带 resetAt；`usedPercent` 非有限数 ⇒ 跳过该窗口；一个池
 *   至少有 1 个窗口才产出快照。全 typeof 守卫、永不抛。
 */

import { DEFAULT_USER_AGENT } from "../http.js";
import type { Millis } from "../../core/types.js";
import type {
  DroidOverage,
  QuotaPoolId,
  QuotaProblem,
  QuotaWindow,
  QuotaWindowsSnapshot,
  WindowScope,
} from "../types.js";
import type { AdapterDeps, QuotaAdapter } from "./types.js";
import { clampPercent, finiteNumber, isRecord } from "./types.js";

export const FACTORY_BASE_URL = "https://api.factory.ai";
export const FACTORY_LIMITS_PATH = "/api/billing/limits";
/** 同一 refresh pass 里两个池的合并窗口（R6：每 pass 至多一次 Factory 请求）。 */
export const DROID_COALESCE_MS = 5_000;

interface ParsedPools {
  readonly standard?: QuotaWindowsSnapshot | undefined;
  readonly core?: QuotaWindowsSnapshot | undefined;
}

/** `fiveHour→"5h"`、`weekly→"week"`、`monthly→"month"`，其余键静默跳过。 */
const WINDOW_KEYS: readonly (readonly [string, WindowScope])[] = [
  ["fiveHour", "5h"],
  ["weekly", "week"],
  ["monthly", "month"],
];

/** windowEnd：字符串 ⇒ Date.parse；数字 ⇒ >1e12 视为毫秒、否则秒；null/缺失 ⇒ undefined（回落 secondsRemaining）。 */
function parseWindowEnd(value: unknown): Millis | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
  }
  return undefined;
}

function parseWindow(raw: unknown, scope: WindowScope, now: Millis): QuotaWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const used = finiteNumber(raw.usedPercent);
  if (used === undefined) return undefined;
  let resetAt = parseWindowEnd(raw.windowEnd);
  if (resetAt === undefined) {
    const secondsRemaining = finiteNumber(raw.secondsRemaining);
    if (secondsRemaining !== undefined && secondsRemaining > 0) resetAt = now + Math.round(secondsRemaining * 1000);
  }
  // K4（droid 客户端语义）：active = windowEnd 存在且 ≥ now（本层用 resetAt > now
  // 表达；reset-elapsed 的窗口由 ladder 规则 0 归零）。未激活 ⇒ 0%、不带 resetAt。
  const active = resetAt !== undefined && resetAt > now;
  return active ? { scope, usedPct: Math.round(clampPercent(used)), resetAt } : { scope, usedPct: 0 };
}

/** 真机字段名 overagePreference（2026-10-14 SP4），旧名 overage 回退；只认 "droidCore" / "extraUsage"，其余一律 "off"（droid 语义 blocked）。 */
function parseOverage(value: unknown): DroidOverage {
  return value === "droidCore" || value === "extraUsage" ? value : "off";
}

function parsePool(
  raw: unknown,
  rawRoot: Record<string, unknown>,
  pool: QuotaPoolId,
  now: Millis,
): QuotaWindowsSnapshot | undefined {
  if (!isRecord(raw)) return undefined;
  const windows: QuotaWindow[] = [];
  for (const [key, scope] of WINDOW_KEYS) {
    const w = parseWindow(raw[key], scope, now);
    if (w !== undefined) windows.push(w);
  }
  if (windows.length === 0) return undefined; // 无可用窗口 = 无快照，不是空快照
  // billing 字段（overage / extraUsageAllowed / extraUsageBalanceCents）是账户级的，
  // 从顶层读取，两个池各带一份（pool 字段各自标注）。余额：非数字记 0，负数钳到 0，取整。
  const balanceRaw = finiteNumber(rawRoot.extraUsageBalanceCents);
  const extraUsageBalanceCents = balanceRaw === undefined ? 0 : Math.max(0, Math.round(balanceRaw));
  return {
    provider: pool === "standard" ? "droid-standard" : "droid-core",
    kind: "windows",
    windows,
    fetchedAt: now,
    billing: {
      kind: "factory",
      pool,
      overage: parseOverage(rawRoot.overagePreference ?? rawRoot.overage),
      extraUsageAllowed: rawRoot.extraUsageAllowed === true,
      extraUsageBalanceCents,
    },
  };
}

/**
 * `GET /api/billing/limits` 响应 → 两份池快照（全 typeof 守卫、永不抛）。
 * `raw.limits` 不是对象 ⇒ undefined（`usesTokenRateLimitsBilling` 只作参考，
 * 不单独判定）。billing 字段（overage / extraUsageAllowed / extraUsageBalanceCents）
 * 从顶层读取，两个池各带一份（pool 字段各自标注）。
 */
export function parseFactoryLimits(raw: unknown, now: Millis): ParsedPools | undefined {
  if (!isRecord(raw)) return undefined;
  const limits = raw.limits;
  if (!isRecord(limits)) return undefined;
  const standard = parsePool(limits.standard, raw, "standard", now);
  const core = parsePool(limits.core, raw, "core", now);
  if (standard === undefined && core === undefined) return undefined;
  return {
    ...(standard === undefined ? {} : { standard }),
    ...(core === undefined ? {} : { core }),
  };
}

export interface DroidAdapterPair {
  readonly standard: QuotaAdapter;
  readonly core: QuotaAdapter;
}

/** 401/403 与 402 的告警文案（§3；文案永不出现 key 本体，测试断言不含 key 子串）。 */
function authProblemText(status: number): string {
  const tail =
    "droid quota tracking is paused; droid is unavailable until successful health evidence, /reload or auth TTL expiry. " +
    "droid runs started from this pi process inherit the " +
    "same key; if you rotated it, restart pi from a shell that has the new key (~/.factory/env.sh is only sourced " +
    "by new shells).";
  if (status === 402) {
    return (
      "[quota] droid: Factory billing API returned HTTP 402 for FACTORY_API_KEY (no active paid subscription " +
      `for that key's organization) — ${tail}`
    );
  }
  return `[quota] droid: Factory billing API rejected FACTORY_API_KEY (HTTP ${status}) — ${tail}`;
}

/**
 * 构造 droid 适配器对子。`isActive`（P5 的晚绑定端口 getter：`pools() !== undefined`）
 * 为 false 时 service 本轮跳过——**不读凭据、不记 lastAttempt、不发请求**（D11）。
 */
export function createDroidAdapters(o: {
  isActive: () => boolean;
  warn?: ((m: string) => void) | undefined;
  coalesceMs?: number | undefined;
  /** Live health evidence, once per actual request (undefined = parsed success), not warnOnce-deduped. */
  onAvailability?: ((problem: QuotaProblem | undefined) => void) | undefined;
}): DroidAdapterPair {
  const coalesceMs = o.coalesceMs ?? DROID_COALESCE_MS;
  // pair 闭包状态（每 stack 一份；无模块级状态）：
  let inflight: Promise<ParsedPools | undefined> | undefined;
  let last: { readonly at: Millis; readonly parsed: ParsedPools | undefined } | undefined;
  let problem: QuotaProblem | undefined;
  const warnedStatuses = new Set<number>();

  const safeWarn = (message: string): void => {
    try {
      o.warn?.(message);
    } catch {
      // 日志通道不能破坏「永不抛」契约。
    }
  };

  const noteAvailability = (value: QuotaProblem | undefined): void => {
    try {
      o.onAvailability?.(value);
    } catch {
      /* Health observers must not break quota's never-throw contract. */
    }
  };

  const noteHttpError = (status: number | undefined): void => {
    if (status !== 401 && status !== 402 && status !== 403) return;
    problem = { family: "droid", status };
    noteAvailability(problem);
    if (warnedStatuses.has(status)) return;
    warnedStatuses.add(status);
    safeWarn(authProblemText(status));
  };

  /** 单次共享请求（调用方负责 inflight 的同步赋值与清理）。永不抛。 */
  const doFetch = async (deps: AdapterDeps): Promise<ParsedPools | undefined> => {
    try {
      const userAgent = deps.userAgent === "" ? DEFAULT_USER_AGENT : deps.userAgent;
      const raw = await deps.fetchJson(`${deps.baseUrl}${FACTORY_LIMITS_PATH}`, {
        headers: {
          Authorization: `Bearer ${deps.apiKey ?? ""}`,
          "User-Agent": userAgent,
        },
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        onHttpError: noteHttpError,
      });
      const parsed = parseFactoryLimits(raw, deps.now());
      if (parsed !== undefined) {
        problem = undefined; // 解析成功 ⇒ 清掉 problem，并恢复 provider 可用性。
        noteAvailability(undefined);
      }
      return parsed;
    } catch {
      return undefined; // fetchJson 契约永不抛；此 catch 兜注入桩异常——绝不抛
    }
  };

  const fetchPool = async (pool: QuotaPoolId, deps: AdapterDeps): Promise<QuotaWindowsSnapshot | undefined> => {
    try {
      if (typeof deps.apiKey !== "string" || deps.apiKey === "") return undefined; // 无 key 不发请求
      if (inflight !== undefined) {
        const shared = await inflight;
        return shared?.[pool];
      }
      const now = deps.now();
      if (last !== undefined && now - last.at >= 0 && now - last.at < coalesceMs) return last.parsed?.[pool];
      // 在首个 await 之前同步赋值：同一 pass 里的另一个池必须能搭车。
      const request = doFetch(deps);
      inflight = request;
      try {
        const parsed = await request;
        last = { at: deps.now(), parsed };
        return parsed?.[pool];
      } finally {
        if (inflight === request) inflight = undefined;
      }
    } catch {
      return undefined; // 绝不抛
    }
  };

  const makeAdapter = (id: "droid-standard" | "droid-core", pool: QuotaPoolId): QuotaAdapter => ({
    id,
    kind: "windows",
    defaultBaseUrl: FACTORY_BASE_URL,
    isActive: o.isActive,
    lastProblem: () => problem,
    fetchQuota: (deps) => fetchPool(pool, deps),
  });

  return { standard: makeAdapter("droid-standard", "standard"), core: makeAdapter("droid-core", "core") };
}
