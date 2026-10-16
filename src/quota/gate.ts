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
import {
  isDroidQuotaId,
  type DroidPoolAdvice,
  type DroidPoolAlternative,
  type DroidPoolListingEntry,
  type LadderLevel,
  type QuotaPoolId,
} from "./types.js";
import type { QuotaModelView } from "./service.js";
import {
  alternativesAdvice,
  demotionFloorClause,
  formatResetAt,
  formatScope,
  poolLabel,
  quotaLabel,
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
  /**
   * droid 池判定视图（quota-plan r2 §2.4/§6；stack.ts 接 `QuotaService.verdictsForModel`）。
   * 返回 undefined ⇒ 该模型不受池管理 ⇒ 走旧路径（字节不变）。
   */
  readonly modelView?: ((model: ModelRef) => QuotaModelView | undefined) | undefined;
  /** droid 内替代（D7 对称化；stack.ts 接 `QuotaService.poolAlternatives`）：另一池推荐 +
   * 两池逐池清单（DroidPoolAdvice）。空数组 ⇒ 选中对象形状与旧版一致。 */
  readonly poolAlternatives?: ((blocked: string) => readonly DroidPoolAdvice[] | undefined) | undefined;
  /**
   * pi provider 被拦时的补充候选（2026-10-15 用户拍板；stack.ts 接
   * `QuotaService.droidAlternatives`）。缺席/返回空 ⇒ 选中对象形状与旧版一致
   * （kimi/zai golden 钉住）；external 分支（droid 池被拦）不读它。
   */
  readonly droidAlternatives?: (() => readonly DroidPoolAlternative[] | undefined) | undefined;
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
  // droid 池路径（quota-plan r2 §6）：按模型所属计费池判定；view undefined ⇒ 旧路径。
  const view = deps.modelView?.(model);
  if (view !== undefined) return evaluatePooledGate(model, view, deps);
  // 无快照 = 非受管 provider（中转池/自建网关，plan §12 明确不做）：放行。
  const verdict = deps.verdictFor(model.provider);
  if (verdict === undefined) return undefined;
  // R5：陈旧快照绝不阻断——闸门退化为今天的行为，真实 429 走原有回退链。
  // 重置时刻已过的窗口在 ladder（windowLevel 规则 0 reset-elapsed）就已等级归零，
  // 不会走入这里的 level——闸门只读判定，不重复实现窗口级过期。
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
 * droid 池闸门（quota-plan r2 §6，D5 拍板；2026-10-16 回落修订）：standard 池 ⇒ 只看
 * 该池；core 池 ⇒ view 携 [droid-core, droid-standard] 两池（Factory 实测：Core 池额度
 * 耗尽后 Core 模型回落计入 Standard 池额度继续跑）⇒ 两池都触线才拦；池未知 ⇒ 两个池
 * 都触线才拦；任一所需池无快照/陈旧 ⇒ 放行（fail-open）。`billing.gateOpen === true`
 * （quota.droidAllowExtraUsage，D6）的池不算触线。
 */
function evaluatePooledGate(model: ModelRef, view: QuotaModelView, deps: QuotaGateDeps): QuotaGateVerdict | undefined {
  if (view.keys.length === 0) return undefined; // "none"：BYOK 不计费，恒放行
  const verdicts: ProviderVerdict[] = [];
  for (const v of view.verdicts) {
    if (v === undefined || v.stale) return undefined; // fail-open
    verdicts.push(v);
  }
  for (const v of verdicts) {
    if (v.level < deps.blockAtLevel || v.billing?.gateOpen === true) return undefined;
  }
  const blocked = view.keys[0] ?? "droid-standard";
  // D7 对称化：droid 池被拦 ⇒ 建议包（另一池推荐 + 逐池清单）随 selection 透传；
  // 池未知时另一池必已触线（闸门才拦）⇒ models 自然为空，listing 仍逐池报状态。
  const picked = pickAlternatives(blocked, deps, DEFAULT_ALTERNATIVE_LIMIT);
  const alternatives: AlternativeSelection = picked.external === true ? picked : { ...picked, external: true };
  let level: LadderLevel = 0;
  for (const v of verdicts) if (v.level > level) level = v.level;
  return {
    level,
    message: buildPooledGateMessage(model, view, verdicts, alternatives, deps.now),
    alternatives,
  };
}

/** `$12.34`（与 render.ts 的 extraUsageText 同口径）。 */
function extraCentsText(cents: number): string {
  return `$${(Math.max(0, Math.round(cents)) / 100).toFixed(2)}`;
}

/** droid 池快速失败文案（§6）：池已知/未知两种首行 + extraUsage 追加行 + 替代建议。 */
function buildPooledGateMessage(
  model: ModelRef,
  view: QuotaModelView,
  verdicts: readonly ProviderVerdict[],
  alternatives: AlternativeSelection,
  now: Millis,
): string {
  const name = `${model.provider}/${model.id}`;
  let head: string;
  const pool = view.pool === "none" ? undefined : view.pool;
  if (pool === undefined) {
    head =
      `quota gate: ${name}（计费池未知，Standard 与 Core 池均已触线：` +
      `Standard 池 ${windowClause(verdicts[0]!, now)}；Core 池 ${windowClause(verdicts[1]!, now)}），` +
      "本次 spawn 已快速失败，未消耗任何 run。";
  } else if (pool === "core" && verdicts.length > 1) {
    // 回落语义（2026-10-16 实测定界）：Core 模型只有 Core 与 Standard 两池都触线才会
    // 被拦——首行同时给出回落计费池（Standard）的读数。
    head =
      `quota gate: ${name}（Core 池）的 ${windowClause(verdicts[0]!, now)}，` +
      `回落计费的 Standard 池也已触线：${windowClause(verdicts[1]!, now)}，` +
      "本次 spawn 已快速失败，未消耗任何 run。";
  } else {
    head = `quota gate: ${name}（${poolLabel(pool)} 池）的 ${windowClause(verdicts[0]!, now)}，本次 spawn 已快速失败，未消耗任何 run。`;
  }
  const lines: string[] = [head];
  // D6：超额策略为 extraUsage 且未被放行 ⇒ 披露余额与逃生阀（文案、HUD、web 全程可见）。
  const extra = verdicts.find((v) => v.billing?.overage === "extraUsage" && v.billing.gateOpen !== true);
  if (extra?.billing !== undefined) {
    lines.push(
      `Factory 超额策略为 extraUsage（额外余额 ${extraCentsText(extra.billing.extraUsageBalanceCents)}）：` +
        "pi-toolkit 默认不代你花额外余额；确需继续，在 settings 文件把 quota.droidAllowExtraUsage 设为 true。",
    );
  }
  lines.push(alternativesAdvice(alternatives));
  lines.push("（在 settings 文件里把 quota.gate 设为 false 可关闭本闸门。）");
  return lines.join("\n");
}

/**
 * 按额度健康度给候选排序后取前 n 个「provider/id」。排序键：
 * `订阅层 asc, level asc, maxUsedPct asc, 注册表顺序 asc`。已 block 的 provider
 * （自身或任何 level >= gateLevel 的 provider）一律排除。
 *
 * 订阅优先（2026-09 口径修订）：订阅额度窗口内不用就作废。分三层——
 *   tier 0 受管订阅（**新鲜**窗口数据，额度可见）
 *   tier 1 声明订阅（`quota.subscriptionProviders`，无额度数据）
 *   tier 2 其余（按量计费/中转）
 * **只要还有任何订阅候选（tier 0/1），就只推荐订阅**，宁可少于 limit 个；订阅
 * 全部耗尽/被排除时才退到 tier 2。旧口径把非受管视作 level 0 / pct 0 排在最前，
 * 等于一有预警就把流量从「已付费的订阅」推向「按 token 计费」的模型。
 * 2026-10-15 拍板「no trustworthy data ⇒ the subscription does not exist」：
 * 无 verdict / stale 的 provider 不再凭旧窗口数据进 tier 0——只有显式声明的
 * `quota.subscriptionProviders` 条目保留 tier 1，其余落 tier 2（service 层对
 * stale 已直接返回 undefined，这里兑注入桩的防御分支）。
 */
export function pickAlternatives(
  blocked: string,
  deps: Pick<QuotaGateDeps, "verdictFor" | "available" | "isSubscription" | "poolAlternatives" | "droidAlternatives">,
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
    // 无 verdict / stale：数据不可信 ⇒ 不算订阅（2026-10-15 拍板）——只有显式声明
    // 的 `quota.subscriptionProviders` 条目保留 tier 1，其余按量计费层；
    // level/pct 仍按 0 参与排序（不构成排除，闸门对 stale 放行 R5）。
    scored.push({
      provider: candidate.provider,
      tier: declared(candidate.provider) ? 1 : 2,
      level: 0,
      pct: 0,
      order: rank,
    });
  }
  // 有订阅候选 ⇒ 只推荐订阅；否则才退到按量计费。
  const pool = scored.some((s) => s.tier < 2) ? scored.filter((s) => s.tier < 2) : scored;
  pool.sort((a, b) => a.tier - b.tier || a.level - b.level || a.pct - b.pct || a.order - b.order);
  const providers = pool.slice(0, cap).map((s) => s.provider);
  const subscription = pool.length > 0 && pool[0]!.tier < 2;
  // droid 池被拦（quota-plan r2 §6，D8）：返回值带 external: true（pi 行改标题
  // 「改用 pi 原生子 agent」）；另一池有健康候选时再挂 models/modelsPool，逐池清单
  // 非空时挂 poolListing。非 droid 被拦 ⇒ 对象形状与改动前完全一样（kimi/zai golden 钉住）。
  if (isDroidQuotaId(blocked)) {
    return {
      providers,
      subscription,
      external: true,
      ...droidAdviceFields(deps, blocked),
    };
  }
  // 2026-10-15 用户拍板：pi provider 被拦 ⇒ 附上有余量的 droid 池候选（dep 缺席 /
  // 空 / 抛异常 ⇒ 字段缺席，形状与旧版一致）。
  let droidPools: readonly DroidPoolAlternative[] | undefined = undefined;
  try {
    droidPools = deps.droidAlternatives?.();
  } catch {
    droidPools = undefined; // 补充候选链不能拖垮主候选（注入桩兜底）。
  }
  return {
    providers,
    subscription,
    ...((droidPools?.length ?? 0) > 0 ? { droidPools } : {}),
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
 * droid 池被拦时的建议包字段（pickAlternatives / evaluatePooledGate 共用）：读
 * `deps.poolAlternatives` 的首包，展开成 `models`+`modelsPool` / `poolListing` /
 * `coreFallback`（core 回落开放，2026-10-16）四个可选字段。端口缺席 / 抢异常 / 包
 * 全空 ⇒ 无字段（选中对象形状与旧版一致）；
 * 抢异常由 try/catch 兜底（stack 接线永不抛，这里兑注入桩）。
 */
function droidAdviceFields(
  deps: Pick<QuotaGateDeps, "poolAlternatives">,
  blocked: string,
): {
  models?: readonly string[];
  modelsPool?: QuotaPoolId;
  poolListing?: readonly DroidPoolListingEntry[];
  coreFallback?: true;
} {
  let advice: DroidPoolAdvice | undefined = undefined;
  try {
    advice = (deps.poolAlternatives?.(blocked) ?? [])[0];
  } catch {
    advice = undefined;
  }
  if (advice === undefined) return {};
  return {
    ...(advice.models.length > 0 ? { models: advice.models, modelsPool: advice.pool } : {}),
    ...(advice.listing.length > 0 ? { poolListing: advice.listing } : {}),
    ...(advice.coreFallback === true ? { coreFallback: true } : {}),
  };
}

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
  const label = quotaLabel(provider); // kimi/zai 原样返回（字节不变）；droid 虚拟 id 翻译为「droid xx 池」
  const altLine =
    alternatives.providers.length > 0 || alternatives.external === true || (alternatives.droidPools?.length ?? 0) > 0
      ? alternativesAdvice(alternatives)
      : "暂无替代候选，按路由表另选合适模型（可检查 pi /model；窗口重置后自动恢复）。";
  return (
    `quota gate: ${label}${isDemotionFloorOnly(verdict) ? " " : " 的 "}${windowClause(verdict, now)}，本次 spawn 已快速失败，未消耗任何 run。\n` +
    `${altLine}\n` +
    `（在 settings 文件里把 quota.gate 设为 false 可关闭本闸门。）`
  );
}
