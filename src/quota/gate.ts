/**
 * Spawn-side quota gate (quota-plan §3.9 / §6): the synchronous, read-only
 * admission check that fast-fails a spawn whose target provider is over the
 * configured ladder line, handing the model a self-correcting error with
 * ready-to-use alternatives instead of burning a run that is doomed to 429.
 *
 * Pure function, zero IO, zero await — it only reads the injected
 * `verdictFor` snapshot (QuotaService's synchronous cache view). The type of
 * `deps` alone makes it impossible to issue a network request from the spawn
 * path (plan §6「同步性」). Zero pi imports (plan §2 分层纪律).
 *
 * Review fixes baked in:
 *  - Minor 3: providers without a verdict (unmanaged relays like
 *    cloudrouter) count as level 0 / pct 0 in `pickAlternatives` — missing
 *    data must not sort them to the back of the fallback chain.
 *  - Minor 6: the fast-fail copy says「settings 文件」instead of hard-coding
 *    the settings file's absolute path.
 *  - Minor 8: the settings `quota.gateLevel` (a plain `number`, already
 *    clamped to 1..3 by `parseQuotaSettings`) is narrowed through
 *    `toLadderLevel` instead of a bare `as` cast at the assembly site.
 */

import type { ModelCandidate, ModelRef } from "../config/model-hint.js";
import type { Millis } from "../core/types.js";
import { isDemotionFloorOnly, type ProviderVerdict, type WindowVerdict } from "./ladder.js";
import type { LadderLevel } from "./types.js";
import {
  alternativesAdvice,
  demotionFloorClause,
  formatResetAt,
  formatScope,
  type AlternativeSelection,
} from "./render.js";

export interface QuotaGateVerdict {
  readonly level: LadderLevel;
  /** 面向模型的快速失败文案（会成为 spawn config error 的 message）。 */
  readonly message: string;
  readonly alternatives: AlternativeSelection;
}

export interface QuotaGateDeps {
  readonly verdictFor: (provider: string) => ProviderVerdict | undefined;
  readonly available: () => readonly ModelCandidate[];
  readonly blockAtLevel: LadderLevel; // settings.quota.gateLevel
  readonly now: Millis;
  /**
   * settings `quota.subscriptionProviders`：没有额度接口、但实为订阅的 provider
   * （如 copilot-*）。缺省 ⇒ 只有带窗口数据的受管 provider 算订阅。
   */
  readonly isSubscription?: ((provider: string) => boolean) | undefined;
}

/** `quota.subscriptionProviders`（逗号分隔）→ 判定函数；空串 ⇒ 恒 false。 */
export function parseSubscriptionProviders(raw: string): (provider: string) => boolean {
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );
  return (provider) => set.has(provider);
}

/** undefined = 放行。只读缓存，**零 IO、零 await**。 */
export function evaluateQuotaGate(model: ModelRef, deps: QuotaGateDeps): QuotaGateVerdict | undefined {
  // 无快照 = 非受管 provider（中转池/自建网关，plan §12 明确不做）：放行。
  const verdict = deps.verdictFor(model.provider);
  if (verdict === undefined) return undefined;
  // R5：陈旧快照绝不阻断——闸门退化为今天的行为，真实 429 走原有回退链。
  if (verdict.stale) return undefined;
  if (verdict.level < deps.blockAtLevel) return undefined;
  const alternatives = pickAlternatives(model.provider, deps, DEFAULT_ALTERNATIVE_LIMIT);
  return {
    level: verdict.level,
    message: buildGateMessage(model.provider, verdict, alternatives, deps.now),
    alternatives,
  };
}

/**
 * 按额度健康度给候选排序后取前 n 个「provider/id」。排序键：
 * `订阅层 asc, level asc, maxUsedPct asc, 注册表顺序 asc`。已 block 的 provider
 * （自身或任何 level >= gateLevel 的 provider）一律排除。
 *
 * 订阅优先（2026-09 口径修订）：订阅额度窗口内不用就作废。分三层——
 *   tier 0 受管订阅（带窗口数据，额度可见）
 *   tier 1 声明订阅（`quota.subscriptionProviders`，无额度数据）
 *   tier 2 其余（按量计费/中转）
 * **只要还有任何订阅候选（tier 0/1），就只推荐订阅**，宁可少于 limit 个；订阅
 * 全部耗尽/被排除时才退到 tier 2。旧口径把非受管视作 level 0 / pct 0 排在最前，
 * 等于一有预警就把流量从「已付费的订阅」推向「按 token 计费」的模型。
 */
export function pickAlternatives(
  blocked: string,
  deps: Pick<QuotaGateDeps, "verdictFor" | "available" | "isSubscription">,
  limit?: number,
): AlternativeSelection {
  const cap = limit === undefined ? DEFAULT_ALTERNATIVE_LIMIT : Math.max(0, limit);
  if (cap === 0) return { providers: [], subscription: false };
  const exclusion = exclusionLevel(deps);
  const declared = (provider: string): boolean => {
    try {
      return deps.isSubscription?.(provider) === true;
    } catch {
      return false;
    }
  };
  const scored: { provider: string; tier: number; level: LadderLevel; pct: number; order: number }[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const candidate of deps.available()) {
    // 注册表顺序是最后一层 tie-break，先占号再谈排除。
    const rank = order;
    order += 1;
    if (candidate.provider === blocked || seen.has(candidate.provider)) continue;
    seen.add(candidate.provider);
    const verdict = deps.verdictFor(candidate.provider);
    // Minor 3：无 verdict（非受管 provider）⇒ level 0 / pct 0，可入选；
    // stale 快照同理（闸门对 stale 放行，R5，不构成排除理由）。
    if (verdict !== undefined && !verdict.stale) {
      if (verdict.level >= exclusion) continue;
      scored.push({
        provider: candidate.provider,
        tier: verdict.windows.length > 0 ? 0 : declared(candidate.provider) ? 1 : 2,
        level: verdict.level,
        pct: maxUsedPct(verdict),
        order: rank,
      });
      continue;
    }
    // 无 verdict / stale：有窗口数据的 stale 快照仍是订阅（只是数据旧），归订阅层。
    const tier = verdict !== undefined && verdict.windows.length > 0 ? 0 : declared(candidate.provider) ? 1 : 2;
    scored.push({ provider: candidate.provider, tier, level: 0, pct: 0, order: rank });
  }
  // 有订阅候选 ⇒ 只推荐订阅；否则才退到按量计费。
  const pool = scored.some((s) => s.tier < 2) ? scored.filter((s) => s.tier < 2) : scored;
  pool.sort((a, b) => a.tier - b.tier || a.level - b.level || a.pct - b.pct || a.order - b.order);
  return {
    providers: pool.slice(0, cap).map((s) => s.provider),
    subscription: pool.length > 0 && pool[0]!.tier < 2,
  };
}

/** formatModelCandidates 的 annotate 实参：返回 " [5h 92% ⚠]" 之类后缀或 undefined。 */
export function quotaAnnotation(
  candidate: ModelCandidate,
  verdictFor: (provider: string) => ProviderVerdict | undefined,
): string | undefined {
  // 无快照 / 非受管 provider / L0 ⇒ 零标记（输出与今天逐字节相同）。
  const verdict = verdictFor(candidate.provider);
  if (verdict === undefined || verdict.level < 1) return undefined;
  // 等级只来自降位地板：读数与降位矛盾，标读数（`7d 0% ⚠`）只会误导——标降位本身。
  if (isDemotionFloorOnly(verdict)) return ` [⤓demoted${levelMark(verdict.level)}]`;
  // 取该 provider 等级最高的那个窗口来标注（Kimi 周 100% 压过 5h 8%）。
  const w = triggerWindow(verdict);
  if (w === undefined) return undefined;
  return ` [${formatScope(w.scope)} ${pctText(w.usedPct)}%${levelMark(verdict.level)}]`;
}

/**
 * Minor 8（评审）：settings 的 `quota.gateLevel` 静态类型是 `number`（parse
 * 已钳 1..3，但类型系统看不到）——装配面（stack.ts）经本 helper 收窄成
 * LadderLevel，而不是 `as` 裸断言。越界值按就近原则钳回 0..3。
 */
export function toLadderLevel(value: number): LadderLevel {
  if (!Number.isFinite(value) || value < 1) return 0;
  if (value < 2) return 1;
  if (value < 3) return 2;
  return 3;
}

/** §6「取前 3」：一次快速失败错误里最多列 3 个替代，多了反而不可读。 */
const DEFAULT_ALTERNATIVE_LIMIT = 3;

/**
 * 排除线（plan §6）：任何 `level >= gateLevel` 的 provider 不得入选——推荐
 * 一个闸门自己也会拦下的模型只会制造第二次快速失败。`pickAlternatives` 的
 * 签名只 Pick 了 verdictFor/available（hook 侧没有 gateLevel 概念）；
 * `evaluateQuotaGate` 传入完整 deps 时经 `in` 探测（TS ≥ 4.9 unlisted
 * property narrowing）读出，缺席时按默认闸门等级 3 处理。
 */
function exclusionLevel(deps: Pick<QuotaGateDeps, "verdictFor" | "available">): LadderLevel {
  if ("blockAtLevel" in deps) {
    const raw: unknown = deps.blockAtLevel;
    if (typeof raw === "number") return toLadderLevel(raw);
  }
  return 3;
}

/** provider 全部窗口里等级最高者（并列取 usedPct 更高者）——与 render.ts 的同名私有 helper 同款。 */
function triggerWindow(v: ProviderVerdict): WindowVerdict | undefined {
  let best: WindowVerdict | undefined = undefined;
  for (const w of v.windows) {
    if (best === undefined || w.level > best.level || (w.level === best.level && w.usedPct > best.usedPct)) {
      best = w;
    }
  }
  return best;
}

function maxUsedPct(v: ProviderVerdict): number {
  let max = 0;
  for (const w of v.windows) if (w.usedPct > max) max = w.usedPct;
  return max;
}

function pctText(pct: number): number {
  return Math.round(Math.min(100, Math.max(0, Number.isFinite(pct) ? pct : 0)));
}

/** L1 无符号；L2/L3 ` ⚠`（紧凑标记一律英文/符号 token，AGENTS.md UI split；耗尽由 100%/文案/着色表达）。 */
function levelMark(level: LadderLevel): string {
  if (level >= 2) return " ⚠";
  return "";
}

function windowClause(v: ProviderVerdict, now: Millis): string {
  // 等级只来自降位地板（只有 quota.gateLevel ≤ 2 才会拦到这里）：与 L2 预警块同一句解释，
  // 不拿「5h 配额已用 0%」当拦截理由。
  if (isDemotionFloorOnly(v)) return demotionFloorClause(v, now);
  const w = triggerWindow(v);
  if (w === undefined) {
    return "配额状态未知"; // 防御分支：无窗口数据（适配器层不产出）
  }
  const reset = w.resetAt === undefined ? "" : `，${formatResetAt(w.resetAt, now)} 重置`;
  if (w.reason === "exhausted" || w.usedPct >= 100) {
    return `${formatScope(w.scope)} 配额已用尽（${pctText(w.usedPct)}%${reset}）`;
  }
  return `${formatScope(w.scope)} 配额已用 ${pctText(w.usedPct)}%${reset}`;
}

/**
 * §6 快速失败文案（成为 `{ kind: "config", retryable: false }` 的 message）。
 * Minor 6：关闭提示写「settings 文件」，不硬编码 settings 文件的绝对路径
 * （路径可被 PI_* 环境变量改写，硬编码必错）。
 */
function buildGateMessage(
  provider: string,
  verdict: ProviderVerdict,
  alternatives: AlternativeSelection,
  now: Millis,
): string {
  const altLine =
    alternatives.providers.length > 0
      ? alternativesAdvice(alternatives)
      : "暂无替代候选，按路由表另选合适模型（可检查 pi /model；窗口重置后自动恢复）。";
  return (
    `quota gate: ${provider}${isDemotionFloorOnly(verdict) ? " " : " 的 "}${windowClause(verdict, now)}，本次 spawn 已快速失败，未消耗任何 run。\n` +
    `${altLine}\n` +
    `（在 settings 文件里把 quota.gate 设为 false 可关闭本闸门。）`
  );
}
