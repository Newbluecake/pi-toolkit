/**
 * QuotaService (docs/dev/quota/quota-plan.md §3.8 / D2 / §5.3 / §7): the single
 * live state holder of the quota feature.
 *
 * - `verdicts()` / `verdictFor()`：**同步**、只读内存（spawn 闸门 / hook /
 *   HUD 的唯一入口），永不发请求、永不抛。
 * - `refreshIfStale()`：fire-and-forget（永不返回被拒 Promise）。TTL 缓存
 *   （`now - fetchedAt < refreshMs` ⇒ 空转）+ per-provider 在途去重；无快照
 *   的 provider 额外按 `refreshMs` 对「上次尝试」退避，端点挂了也不会每轮
 *   turn 都去撞墙（偏差记录：plan 只定义了快照 TTL，此为同节流的自然延伸）。
 *   例外（ladder 规则 0 的数据面配套）：任一窗口的 `resetAt` 已过 ⇒ 读数已知
 *   过期，绕过 TTL 立即重拉（在途去重照常兜住并发触发；可疑读数退避不绕过）。
 * - **零 setInterval/setTimeout**（D2：懒触发为主，不装任何 timer——测试用
 *   `FakeClock.pendingTimers === 0` 锁死）。
 * - 刷新落地后先做**异常读数防护**（2026-09-24 kimi 现场：上游 502 风暴期间
 *   `/usages` 短暂返回归零且无 resetAt 的窗口）：逐窗口判回落——跌幅
 *   ≥ QUOTA_HYSTERESIS_PCT 且有重置证据（旧 resetAt 已过，或 resetAt 前移
 *   ≥ RESET_ADVANCE_TOLERANCE_MS）⇒ 已验证重置；有回落无证据 ⇒ 可疑：本次**不替换
 *   快照、不推样本、不动降位**，记一条待确认读数并把下次拉取推迟一个 refreshMs；
 *   下一次拉取仍给出同一窗口的回落 ⇒ 确认为服务端提前重置，按已验证重置处理。
 * - 已验证重置（任一窗口）⇒ `demotions.clear` + 重启该窗口样本环（跨重置的斜率
 *   是垃圾）；其余窗口照常追加样本；随后 verdict level ≥ 3 ⇒ `demotions.mark`
 *   （仍有别的窗口在 L3 就当场重新降位）；最后写 HUD status 行。
 * - dispose（M3 评审修订，单一所有者、幂等）：`setStatus(undefined)` 恰一次；
 *   在途刷新落地后**拒写 status、拒改状态**；`QuotaStack.dispose()` 只是纯转发。
 */

import type { Clock } from "../core/clock.js";
import type { QuotaSettings } from "../config/settings.js";
import type { Millis } from "../core/types.js";
import type { DemotionStore } from "./demotion.js";
import { toLadderLevel } from "./gate.js";
import { forecast, pushSample, type BurnSample } from "./forecast.js";
import {
  providerVerdict,
  QUOTA_HYSTERESIS_PCT,
  type LadderThresholds,
  type ProviderVerdict,
  type QuotaRecoveryEvent,
} from "./ladder.js";
import { renderQuotaStatus, type QuotaStatusTheme } from "./render.js";
import {
  DROID_PROVIDER,
  DROID_QUOTA_IDS,
  isDroidQuotaId,
  isQuotaProviderId,
  type CredentialResolver,
  type DroidPoolAdvice,
  type DroidPoolAlternative,
  type DroidPoolListingEntry,
  type DroidPoolState,
  type FetchJson,
  type LadderLevel,
  type ProviderAdapter,
  type QuotaPoolId,
  type QuotaPoolPort,
  type QuotaProblem,
  type QuotaProviderId,
  type QuotaSnapshot,
  type QuotaWindow,
  type WindowScope,
} from "./types.js";
import type { CatalogModelLike } from "./pools.js";

/**
 * `verdictsForModel` 的返回（quota-plan r2 §2.4）：按模型所属计费池解析出的判定视图。
 * 池已知 ⇒ keys 为对应单个虚拟 id；未知 ⇒ 两个池（D5：两池都触线才拦）；
 * `"none"`（BYOK 不计费）⇒ 空 keys（闸门放行）。
 */
export interface QuotaModelView {
  readonly pool: QuotaPoolId | "none" | undefined;
  readonly keys: readonly QuotaProviderId[];
  /** 与 keys 对齐；undefined = 无快照。 */
  readonly verdicts: readonly (ProviderVerdict | undefined)[];
}

export interface QuotaService {
  /**
   * **同步**读缓存判定（spawn 闸门 / hook / HUD 唯一入口）。永不发请求、永不抛。
   * 信任过滤（2026-10-15 终版拍板「数据拿不到就当没有该订阅」）：快照缺席 / stale /
   * （droid 池）鉴权失败的 provider 一律不可见——`verdicts()` 不含它，`verdictFor()`
   * 返回 undefined（闸门对 undefined 本就 fail-open，永不因缺数据拦 spawn）。
   */
  verdicts(now?: Millis): readonly ProviderVerdict[];
  verdictFor(provider: string, now?: Millis): ProviderVerdict | undefined;
  /**
   * 按模型判定（droid 池闸门，quota-plan r2 §2.4）：undefined ⇒ 该模型不受池管理
   * （非 droid / droid 适配器未构造）⇒ 闸门走旧路径。同步、只读。
   */
  verdictsForModel(model: { provider: string; id: string }, now?: Millis): QuotaModelView | undefined;
  /** droid 池被拦时的补充候选：另一池无可信数据（缺席 / stale / 鉴权失败）或触闸门线
   *  ⇒ 不推荐；逐池清单只含可信池。闸门本身仍 fail-open（不因缺数据拦 spawn）。 */
  poolAlternatives(blocked: string, limit?: number): readonly DroidPoolAdvice[];
  /**
   * pi provider 被拦/告急时的补充候选（2026-10-15 用户拍板）：可信（新鲜快照、无鉴权
   * 问题）且未触闸门线的 droid 池模型，core 池在前、每池 ≤limit 个 `droid/<id>`
   * （gate 关闭时仍按 L3 排除；触线池即使 gateOpen（花额外余额）也不列）。无可信
   * 数据的池不列（终版拍板）。池端口缺席（droid 未启用/未接线）或两池都不可用 ⇒ []，
   * 调用方输出字节不变。
   */
  droidAlternatives(limit?: number): readonly DroidPoolAlternative[];
  /** 恒 []（2026-10-15 终版拍板）：鉴权问题不进任何 UI；适配器仍记录（信任判定用）。 */
  problems(): readonly QuotaProblem[];
  /** fire-and-forget；未过期或在途则空转。永不抛、永不返回被拒 Promise。 */
  refreshIfStale(): void;
  /** 仅测试：等待当前所有在途刷新落地。 */
  whenIdle(): Promise<void>;
  /** 单一所有者清理（M3 评审修订）：幂等。含 setStatus(undefined)、在途刷新落地后拒写 status、降位 flush。 */
  dispose(): void;
}

export interface QuotaServiceDeps {
  readonly settings: QuotaSettings;
  readonly clock: Clock;
  readonly adapters: readonly ProviderAdapter[];
  readonly credentials: CredentialResolver;
  readonly fetchJson: FetchJson;
  readonly demotions: DemotionStore;
  /** HUD 一行；不可用时省略（子会话/print 模式）。 */
  readonly setStatus?: ((text: string | undefined) => void) | undefined;
  /** HUD 主题（ctx.ui.theme 的结构子集）；旧 pi / 非 TUI 时 undefined ⇒ 纯文本。 */
  readonly theme?: (() => QuotaStatusTheme | undefined) | undefined;
  readonly warn?: ((message: string) => void) | undefined;
  /**
   * 晚绑定池端口（P5 经 createCatalogPoolPort 供给；quota-plan r2 §2.1）。缺席 ⇒
   * droid 模型的池恒未知（D5 fail-open）。端口 getter 返回 undefined 时同样退化。
   */
  readonly pools?: (() => QuotaPoolPort | undefined) | undefined;
  /**
   * 观测重置分支的恢复事件出口（额度恢复播报）：快照被接受且 classifyDrop 认定
   * 重置（有证据 / 两次确认）时，在全部状态落定（降位当场重建、HUD）之后每 provider
   * 每次至多调用一次。回调异常被吞（数据面不可被注入面拖垮）。可疑读数拒收路径
   * 早 return，天然不触发。
   */
  readonly onObservedReset?: ((event: QuotaRecoveryEvent) => void) | undefined;
}

/**
 * resetAt 前移多少才算「窗口已滚动」的证据：两家适配器给的都是绝对重置时刻，真实重置
 * 会让它前移一整个窗口（5h / 7d）；1 分钟容差只为吸收两次拉取间的时间戳抖动。
 */
export const RESET_ADVANCE_TOLERANCE_MS = 60_000;

/** 逐池清单每池最多列多少个模型（2026-10-15 拍板的截断上限，超出写「等 N 个」）。 */
const DROID_POOL_LISTING_LIMIT = 5;

/** 可疑读数的待确认记录：哪些窗口回落了但没有重置证据。 */
interface SuspectRead {
  readonly fetchedAt: Millis;
  readonly scopes: ReadonlySet<WindowScope>;
}

/**
 * §5.3 ② 观测重置（2026-09 修订：必须有证据）。单窗口回落分类：
 * - `none`：没有回落 ≥ QUOTA_HYSTERESIS_PCT（或旧快照无此窗口）；
 * - `reset`：回落且有重置证据——旧 resetAt 已过，或新 resetAt 前移；
 * - `unverified`：回落但无证据（now < 旧 resetAt 且新 resetAt 缺失/未前移，或双方都无
 *   resetAt 可比）——交给调用方做两次确认。
 */
function classifyDrop(old: QuotaWindow | undefined, next: QuotaWindow, at: Millis): "none" | "reset" | "unverified" {
  if (old === undefined) return "none";
  if (next.usedPct > old.usedPct - QUOTA_HYSTERESIS_PCT) return "none";
  if (old.resetAt !== undefined) {
    if (at >= old.resetAt) return "reset";
    if (next.resetAt !== undefined && next.resetAt - old.resetAt >= RESET_ADVANCE_TOLERANCE_MS) return "reset";
  }
  return "unverified";
}

export function createQuotaService(deps: QuotaServiceDeps): QuotaService {
  const { settings, clock } = deps;
  const snapshots = new Map<QuotaProviderId, QuotaSnapshot>();
  const rings = new Map<string, readonly BurnSample[]>();
  const inflight = new Map<QuotaProviderId, Promise<void>>();
  const lastAttempt = new Map<QuotaProviderId, Millis>();
  /** 被拒的可疑读数（每 provider 至多一条）；下一次拉取据此做二次确认。 */
  const suspects = new Map<QuotaProviderId, SuspectRead>();
  let disposed = false;

  const safeWarn = (message: string): void => {
    try {
      deps.warn?.(message);
    } catch {
      // 日志通道不能破坏「永不抛」契约。
    }
  };

  const thresholds = (scope: WindowScope): LadderThresholds => {
    const w = settings.windows[scope];
    // D10：month 窗口关闭规则 3b（forecast-before-reset）——月窗口斜率外推必误报；3a 保留。
    return {
      l1: w.l1Percent,
      l2: w.l2Percent,
      l3: w.l3Percent,
      l3EtaMs: settings.l3EtaMs,
      ...(scope === "month" ? { forecastBeforeReset: false } : {}),
    };
  };

  const ringKey = (provider: string, scope: WindowScope): string => `${provider}|${scope}`;

  const baseUrlFor = (id: QuotaProviderId): string => {
    switch (id) {
      case "zai-coding-cn":
        return settings.zaiBaseUrl;
      case "zai":
        return settings.zaiOverseasBaseUrl;
      case "kimi-coding":
        return settings.kimiBaseUrl;
      case "droid-standard":
      case "droid-core":
        return settings.factoryBaseUrl;
    }
  };

  const verdictOf = (id: QuotaProviderId, now: Millis): ProviderVerdict | undefined => {
    const snapshot = snapshots.get(id);
    if (snapshot === undefined) return undefined;
    const etaCache = new Map<WindowScope, Millis | undefined>();
    const etaOf = (scope: WindowScope): Millis | undefined => {
      const cached = etaCache.get(scope);
      if (cached !== undefined || etaCache.has(scope)) return etaCache.get(scope);
      const ring = rings.get(ringKey(id, scope)) ?? [];
      const eta = forecast(ring, now).etaMs;
      etaCache.set(scope, eta);
      return eta;
    };
    let demotedUntil: Millis | undefined = undefined;
    let demoted = false;
    try {
      const record = deps.demotions.get(id, now);
      demoted = record !== undefined;
      demotedUntil = record?.expiresAt;
    } catch {
      demoted = false; // demotion store 契约永不抛；此兜底为注入桩而设。
    }
    try {
      const verdict = providerVerdict(snapshot, {
        now,
        thresholds,
        staleAfterMs: settings.staleAfterMs,
        etaOf,
        demoted,
        demotedUntil,
      });
      // D6（拍板）service 装饰：standard 池 + extraUsage + 账户允许 + 余额 >0，且用户
      // 显式打开 quota.droidAllowExtraUsage ⇒ gateOpen（闸门放行，文案/HUD 披露余额）。
      // 只有 verdict.billing 存在（droid 池）才返回新对象——kimi/zai 的对象引用与形状不变。
      const billing = verdict.billing;
      if (billing === undefined) return verdict;
      const gateOpen =
        settings.droidAllowExtraUsage &&
        billing.pool === "standard" &&
        billing.overage === "extraUsage" &&
        billing.extraUsageAllowed &&
        billing.extraUsageBalanceCents > 0;
      return { ...verdict, billing: { ...billing, gateOpen } };
    } catch {
      return undefined; // 纯函数层不应抛；万一抛了（注入桩）也不拖垮整批 verdict。
    }
  };

  const verdictsNow = (now: Millis): readonly ProviderVerdict[] => {
    const out: ProviderVerdict[] = [];
    for (const adapter of deps.adapters) {
      const verdict = trustedVerdictOf(adapter.id, now);
      if (verdict !== undefined) out.push(verdict);
    }
    return out;
  };

  /**
   * 信任判定出口（2026-10-15 终版拍板：「只要订阅数据拿不到，就当做没有对应的订阅
   * 套餐」）：快照缺席 / stale /（droid 池）鉴权失败 ⇒ 该 provider 对一切消费面
   * （注入流 / HUD / web / 闸门判定 / 替代建议）均不可见。闸门对 undefined 本就
   * fail-open，永不因缺数据拦 spawn；内部刷新节奏仍用原始 verdictOf。
   */
  const trustedVerdictOf = (id: QuotaProviderId, now: Millis): ProviderVerdict | undefined => {
    const verdict = verdictOf(id, now);
    if (verdict === undefined || verdict.stale) return undefined;
    if (isDroidQuotaId(id) && droidAuthProblem() !== undefined) return undefined;
    return verdict;
  };

  // Hot providers are refreshed more often independently; an L1 snapshot or a
  // forecast that reaches exhaustion within an hour is enough to enter hot mode.
  const effectiveTtl = (id: QuotaProviderId, now: Millis): Millis => {
    const verdict = verdictOf(id, now);
    const hot =
      verdict?.level !== undefined &&
      (verdict.level >= 1 || verdict.windows.some((window) => window.etaMs !== undefined && window.etaMs < 3_600_000));
    return hot ? settings.refreshHotMs : settings.refreshMs;
  };

  /** HUD 行写入（R8：setStatus 可能来自陈旧 ctx，双探测 + try/catch 由注入方负责，这里再兜一层）。 */
  const writeStatus = (now: Millis): void => {
    if (disposed || deps.setStatus === undefined) return;
    try {
      // 不可信的 provider 在 verdictsNow 里已被过滤；鉴权问题不再进任何 UI（终版拍板）。
      deps.setStatus(renderQuotaStatus(verdictsNow(now), now, settings.refreshMs, deps.theme?.(), []));
    } catch {
      // HUD 不可用不影响数据面。
    }
  };

  /** 认证类问题汇总（401/402/403），按 family 去重；适配器桩异常吞掉。 */
  const problemsNow = (): readonly QuotaProblem[] => {
    const out: QuotaProblem[] = [];
    const seen = new Set<string>();
    for (const adapter of deps.adapters) {
      let problem: QuotaProblem | undefined;
      try {
        problem = adapter.lastProblem?.();
      } catch {
        problem = undefined; // 端口契约永不抛；兜注入桩。
      }
      if (problem !== undefined && !seen.has(problem.family)) {
        seen.add(problem.family);
        out.push(problem);
      }
    }
    return out;
  };

  /** 模型 → 池：settings.droidPools 覆盖优先（R1 纠错主通道），端口启发式其次（D4）。 */
  const poolFor = (modelId: string): QuotaPoolId | "none" | undefined => {
    const override = settings.droidPools[modelId];
    if (override !== undefined) return override;
    try {
      return deps.pools?.()?.poolOf(modelId);
    } catch {
      return undefined; // 端口契约永不抛；兜注入桩。
    }
  };

  /**
   * §5.6 候选加减法（评审 #5，poolAlternatives / droidAlternatives 共用）：加法 =
   * 端口目录序（偏好序在前，已滤 deprecated/router/custom:）+ droidPools 改判进该池
   * 的键；减法 = custom:、被改判出该池的、目录标 deprecated/router 的；去重后返回
   * 裸模型 id（无 droid/ 前缀、未截断）。目录查不到的覆盖键保留（用户明确意图）。
   */
  const poolCandidates = (pool: QuotaPoolId): readonly string[] => {
    let port: QuotaPoolPort | undefined;
    try {
      port = deps.pools?.();
    } catch {
      port = undefined;
    }
    const candidates: string[] = [];
    const seen = new Set<string>();
    const push = (id: string): void => {
      if (!seen.has(id)) {
        seen.add(id);
        candidates.push(id);
      }
    };
    if (port !== undefined) {
      try {
        for (const id of port.modelsInPool(pool)) push(id); // 已是「偏好序在前、目录序在后」
      } catch {
        // 端口契约永不抛；兜注入桩。
      }
    }
    for (const [id, value] of Object.entries(settings.droidPools)) {
      if (value === pool) push(id); // 评审 #5 加法：用户改判进该池的模型进替代建议
    }
    const infoOf = (id: string): CatalogModelLike | undefined => {
      // CatalogPoolPort 的结构探测（quota 不自持目录；P5 供的端口带 infoOf）。
      const capable = port as { infoOf?: (modelId: string) => CatalogModelLike | undefined } | undefined;
      try {
        return capable?.infoOf?.(id);
      } catch {
        return undefined;
      }
    };
    return candidates.filter((id) => {
      if (id.startsWith("custom:")) return false;
      const override = settings.droidPools[id];
      if (override !== undefined && override !== pool) return false; // 减法：被改判出该池
      const info = infoOf(id);
      if (info !== undefined && (info.deprecated === true || info.kind === "router")) return false;
      return true; // 覆盖键在目录里查不到 ⇒ 保留（用户明确意图）
    });
  };

  /** 闸门线（poolAlternatives / droidAlternatives / 逐池清单共用同一口径）：gate 关 ⇒ 按 L3。 */
  const gateLine = (): LadderLevel => (settings.gate ? toLadderLevel(settings.gateLevel) : 3);

  /**
   * 当前 droid 鉴权问题（家族级：两个池适配器共享同一个 401/402/403 记录，一次
   * 请求同时服务两池，成功解析才清除）。非 undefined ⇒ 两池都视为不可信：不进推荐行，
   * 也从逐池清单里整池省略（即使还有未过期的旧快照在缓存里）。
   */
  const droidAuthProblem = (): QuotaProblem | undefined => {
    try {
      return problemsNow().find((p) => p.family === "droid");
    } catch {
      return undefined; // 兜注入桩；不可用时退化为仅按快照判读。
    }
  };

  /**
   * 池可推荐判定（2026-10-15 拍板「no trustworthy data ⇒ the subscription does not
   * exist」）：可信（快照存在、新鲜、无鉴权问题）且等级低于闸门线。缺席 / stale /
   * 402 / 触线 ⇒ 一律不推荐（闸门本身仍 fail-open，只是推荐行不导它）。
   */
  const poolRecommendable = (verdict: ProviderVerdict | undefined): boolean =>
    poolTrusted(verdict) && verdict.level < gateLine();

  /** 池可信（仅数据面判读，与等级无关；类型谓词：true ⇒ verdict 非空）：不可信的池
   * 在清单/推荐里整池不可见（终版拍板）。 */
  const poolTrusted = (verdict: ProviderVerdict | undefined): verdict is ProviderVerdict =>
    verdict !== undefined && !verdict.stale && droidAuthProblem() === undefined;

  /** 逐池清单状态（仅对可信池调用）：等级 vs 闸门线。 */
  const poolStateOf = (verdict: ProviderVerdict, line: LadderLevel): DroidPoolState => {
    if (verdict.level >= line) return "blocked";
    if (verdict.level >= 1) return "warn";
    return "ok";
  };

  /** 逐池清单（2026-10-15 用户要求）：每池 ≤DROID_POOL_LISTING_LIMIT 个候选 + 状态 + 总数；
   * 零候选池省略；不可信的池（缺席 / stale / 鉴权失败）整池省略——数据拿不到就当没有
   * 该订阅，不出「无数据」文案。 */
  const poolListingEntries = (): readonly DroidPoolListingEntry[] => {
    const line = gateLine();
    const out: DroidPoolListingEntry[] = [];
    for (const pool of ["standard", "core"] as const) {
      const candidates = poolCandidates(pool);
      if (candidates.length === 0) continue;
      const verdict = verdictOf(pool === "standard" ? "droid-standard" : "droid-core", clock.now());
      if (!poolTrusted(verdict)) continue;
      out.push({
        pool,
        state: poolStateOf(verdict, line),
        total: candidates.length,
        models: candidates.slice(0, DROID_POOL_LISTING_LIMIT).map((id) => `droid/${id}`),
      });
    }
    return out;
  };

  /**
   * 刷新落地：异常读数防护 → 存快照 → 重置检测/样本环 → 降位标记 → HUD。
   * 调用方保证 disposed === false。
   */
  const applySnapshot = (snapshot: QuotaSnapshot): void => {
    const id = snapshot.provider;
    const now = clock.now();
    const prev = snapshots.get(id);
    const pending = suspects.get(id);
    const resetScopes = new Set<WindowScope>();
    const unverified = new Set<WindowScope>(); // 本次无证据回落的全部窗口（含被二次确认者）
    let rejected = false;
    const drops: string[] = [];
    if (prev !== undefined) {
      for (const w of snapshot.windows) {
        const old = prev.windows.find((p) => p.scope === w.scope);
        const kind = classifyDrop(old, w, snapshot.fetchedAt);
        if (kind === "reset") {
          resetScopes.add(w.scope);
        } else if (kind === "unverified") {
          unverified.add(w.scope);
          drops.push(`${w.scope} ${Math.round(old?.usedPct ?? 0)}%→${Math.round(w.usedPct)}%`);
          // 两次确认：上一条被拒读数也报了这个窗口的回落 ⇒ 认定服务端提前重置。
          if (pending?.scopes.has(w.scope) === true) resetScopes.add(w.scope);
          else rejected = true;
        }
      }
    }
    if (rejected) {
      // 可疑读数：不替换快照、不推样本、不清降位——旧快照继续生效（会自然老化为 stale）。
      suspects.set(id, { fetchedAt: snapshot.fetchedAt, scopes: unverified });
      safeWarn(
        `[quota] ${id}: usage dropped without reset evidence (${drops.join(", ")}); ` +
          "keeping the previous snapshot until the next read confirms it",
      );
      return;
    }
    suspects.delete(id);
    snapshots.set(id, snapshot);
    if (resetScopes.size > 0) {
      // §5.3 ②：有证据的观测重置 ⇒ 清降位（同一次落地里若别的窗口仍在 L3，下面会当场重新降位）。
      try {
        deps.demotions.clear(id);
      } catch {
        // 契约永不抛，兜注入桩。
      }
    }
    for (const w of snapshot.windows) {
      const key = ringKey(id, w.scope);
      const sample: BurnSample = { at: snapshot.fetchedAt, usedPct: w.usedPct };
      // 重置窗口的样本环从新样本重启（跨重置的斜率是垃圾）；其余窗口照常追加。
      rings.set(key, resetScopes.has(w.scope) ? [sample] : pushSample(rings.get(key) ?? [], sample));
    }
    const verdict = verdictOf(id, now);
    if (verdict !== undefined && verdict.level >= 3) {
      // §5.3 写入（2026-09 口径修订：仅 L3 才降位）：L2 只是提示——订阅额度窗口内不用
      // 就作废，提前降位等于把流量推向按量计费模型。触发窗口（level ≥ 3 者）里最早的
      // resetAt；未知 ⇒ demotion 层用 6h TTL。
      const resets: Millis[] = [];
      for (const w of verdict.windows) {
        if (w.level >= 3 && w.resetAt !== undefined) resets.push(w.resetAt);
      }
      const earliest = resets.length > 0 ? Math.min(...resets) : undefined;
      try {
        deps.demotions.mark(id, 3, earliest, now);
      } catch {
        // 契约永不抛，兜注入桩。
      }
    }
    writeStatus(now);
    // 额度恢复播报：观测重置（有证据 / 两次确认）且快照被接受 ⇒ 发一条恢复事件。
    // verdictOf 重算以拿到**终态**——上面 level ≥ 3 的当场重新降位必须反映进事件，
    // 文案据此如实写「仍拦截」，而不是拿 clear 后的中间态误报「已放行」。
    if (resetScopes.size > 0 && deps.onObservedReset !== undefined) {
      const recovered = verdictOf(id, now);
      if (recovered !== undefined) {
        try {
          deps.onObservedReset({
            provider: id,
            resetScopes: new Set(resetScopes),
            verdict: recovered,
            // 镜像 evaluateQuotaGate 的阻断条件（快照刚落地 ⇒ 非 stale）。
            gateBlocked: settings.gate && recovered.level >= toLadderLevel(settings.gateLevel),
            at: now,
          });
        } catch (error) {
          safeWarn(`[quota] ${id} recovery listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  };

  const refreshIfStale = (): void => {
    if (disposed) return;
    for (const adapter of deps.adapters) {
      // D11 关闭态：inactive 适配器本轮跳过——不读凭据、不记 lastAttempt、不发请求。
      if (adapter.isActive?.() === false) continue;
      const id = adapter.id;
      const now = clock.now();
      const ttl = effectiveTtl(id, now);
      const existing = snapshots.get(id);
      if (existing !== undefined) {
        // 窗口已过重置 ⇒ 读数已知过期（判定层已把该窗口视同过期，见 ladder 规则 0）：
        // 绕过 TTL 立即重拉，闸门/注入不再建立在重置前的旧数据上，直到新读数落地。
        // 在途去重照常兜住并发触发；可疑读数的退避不绕过（确认节奏不变）。零 timer。
        // 只认「快照拉取于重置之前」：上游若在重置后仍回报过去的 resetAt（数据滞后），
        // 新快照 fetchedAt ≥ resetAt ⇒ 不再绕过，回到常规 TTL（否则每个触发点都会打一次端点）。
        const resetElapsed = existing.windows.some(
          (w) => w.resetAt !== undefined && w.resetAt <= now && existing.fetchedAt < w.resetAt,
        );
        if (!resetElapsed && now - existing.fetchedAt < ttl) continue; // TTL：按 provider 热/冷状态计算
        // 刚拒过一条可疑读数：确认读数至少隔一个有效刷新周期再拉。
        const suspect = suspects.get(id);
        if (suspect !== undefined && now - suspect.fetchedAt < ttl) continue;
      } else {
        // 无快照（从未成功或上次失败）：按上次尝试时间退避，失败的端点不被每轮 turn 撞击。
        const last = lastAttempt.get(id);
        if (last !== undefined && now - last < ttl) continue;
      }
      if (inflight.has(id)) continue; // per-provider 在途去重
      lastAttempt.set(id, now);
      const attempt = (async (): Promise<void> => {
        let apiKey: string | undefined;
        try {
          apiKey = deps.credentials(id);
        } catch {
          apiKey = undefined; // resolver 契约永不抛；兜注入桩。
        }
        const snapshot = await adapter.fetchQuota({
          fetchJson: deps.fetchJson,
          apiKey,
          now: () => clock.now(),
          baseUrl: baseUrlFor(id),
          userAgent: settings.userAgent,
        });
        // dispose 之后落地：什么都不做（M3 在途防护——拒写 status、拒改状态）。
        if (disposed) return;
        if (snapshot === undefined || snapshot.provider !== id) {
          // 刷新未产出快照但适配器有认证问题（401/402/403，D3）：也写一次 HUD，
          // 让 `droid auth <code>` 在不落快照的情况下显示出来。
          let hasProblem = false;
          try {
            hasProblem = adapter.lastProblem?.() !== undefined;
          } catch {
            hasProblem = false;
          }
          if (hasProblem) writeStatus(clock.now());
          return;
        }
        try {
          applySnapshot(snapshot);
        } catch (error) {
          safeWarn(`[quota] failed to apply ${id} snapshot: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
      const guarded = attempt.catch((error: unknown) => {
        // adapter 契约本就「绝不抛」；此 catch 兜注入桩异常——refreshIfStale 永不返回被拒 Promise。
        safeWarn(`[quota] ${id} refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      inflight.set(
        id,
        guarded.then(() => {
          inflight.delete(id);
        }),
      );
    }
  };

  // §7：创建时也写一次 status（此时无快照 ⇒ renderQuotaStatus 返回 undefined ⇒ 清占位）。
  writeStatus(clock.now());

  return {
    verdicts(now) {
      return verdictsNow(now ?? clock.now());
    },
    verdictFor(provider, now) {
      const at = now ?? clock.now();
      return isQuotaProviderId(provider) ? trustedVerdictOf(provider, at) : undefined;
    },
    verdictsForModel(model, now) {
      // 非 droid / droid 适配器未构造 ⇒ 不受池管理 ⇒ 闸门走旧路径（undefined）。
      if (model.provider !== DROID_PROVIDER) return undefined;
      if (!deps.adapters.some((a) => a.id === "droid-standard" || a.id === "droid-core")) return undefined;
      const at = now ?? clock.now();
      const pool = poolFor(model.id);
      const keys: readonly QuotaProviderId[] =
        pool === "none"
          ? []
          : pool === undefined
            ? DROID_QUOTA_IDS
            : [pool === "standard" ? "droid-standard" : "droid-core"];
      // 不可信的池（缺席 / stale / 鉴权失败）⇒ undefined ⇒ 闸门 fail-open（行为不变）。
      return { pool, keys, verdicts: keys.map((k) => trustedVerdictOf(k, at)) };
    },
    poolAlternatives(blocked, limit = 3) {
      // D7 对称化（2026-10-15 用户拍板：两个方向都要列）：被拦的是 droid 池 ⇒ 建议包 =
      // 另一池推荐（无可信数据——快照缺席 / stale / 鉴权失败——或 ≥闸门线 ⇒ models
      // 空，绝不推荐闸门自己也会拦下/读数不真的池）+ 可信池逐池清单。非 droid /
      // 建议包全空（models 与 listing 都空）⇒ []，调用方输出与旧版字节一致。
      if (!isDroidQuotaId(blocked)) return [];
      const other: QuotaPoolId = blocked === "droid-standard" ? "core" : "standard";
      const otherVerdict = verdictOf(other === "core" ? "droid-core" : "droid-standard", clock.now());
      const models = poolRecommendable(otherVerdict)
        ? poolCandidates(other)
            .slice(0, Math.max(0, limit))
            .map((id) => `droid/${id}`)
        : [];
      const listing = poolListingEntries();
      if (models.length === 0 && listing.length === 0) return [];
      return [{ pool: other, models, listing }];
    },
    droidAlternatives(limit = 3) {
      // 2026-10-15 用户拍板：pi provider 被拦/告急时的补充候选。端口缺席 ⇒ []（droid
      // 未启用/未接线，调用方输出字节不变）；无可信数据的池不列（终版拍板「数据拿不到
      // 就当没有该订阅」，不再 fail-open 视同可用）。
      let port: QuotaPoolPort | undefined;
      try {
        port = deps.pools?.();
      } catch {
        port = undefined;
      }
      if (port === undefined) return [];
      const out: DroidPoolAlternative[] = [];
      for (const pool of ["core", "standard"] as const) {
        const verdict = verdictOf(pool === "core" ? "droid-core" : "droid-standard", clock.now());
        if (!poolRecommendable(verdict)) continue;
        const models = poolCandidates(pool)
          .slice(0, Math.max(0, limit))
          .map((id) => `droid/${id}`);
        if (models.length > 0) out.push({ pool, models });
      }
      return out;
    },
    problems() {
      // 终版拍板（2026-10-15）：鉴权问题不进任何 UI（HUD/web/通知）——数据拿不到就当
      // 没有该订阅。适配器的 lastProblem 仍在（信任判定用）+ warnOnce 开发者日志保留。
      return [];
    },
    refreshIfStale,
    whenIdle() {
      return Promise.all([...inflight.values()]).then(() => undefined);
    },
    dispose() {
      if (disposed) return; // M3：幂等——双重 dispose 只清一次 status。
      disposed = true;
      if (deps.setStatus !== undefined) {
        try {
          deps.setStatus(undefined);
        } catch {
          // HUD 不可用不影响清理语义。
        }
      }
    },
  };
}
