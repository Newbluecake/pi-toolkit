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
  isQuotaProviderId,
  type CredentialResolver,
  type FetchJson,
  type ProviderAdapter,
  type QuotaProviderId,
  type QuotaSnapshot,
  type QuotaWindow,
  type WindowScope,
} from "./types.js";

export interface QuotaService {
  /** **同步**读缓存判定（spawn 闸门 / hook / HUD 唯一入口）。永不发请求、永不抛。 */
  verdicts(now?: Millis): readonly ProviderVerdict[];
  verdictFor(provider: string, now?: Millis): ProviderVerdict | undefined;
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

  const thresholds: LadderThresholds = {
    l1: settings.l1Percent,
    l2: settings.l2Percent,
    l3: settings.l3Percent,
    l3EtaMs: settings.l3EtaMs,
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
      return providerVerdict(snapshot, {
        now,
        thresholds,
        staleAfterMs: settings.staleAfterMs,
        etaOf,
        demoted,
        demotedUntil,
      });
    } catch {
      return undefined; // 纯函数层不应抛；万一抛了（注入桩）也不拖垮整批 verdict。
    }
  };

  const verdictsNow = (now: Millis): readonly ProviderVerdict[] => {
    const out: ProviderVerdict[] = [];
    for (const adapter of deps.adapters) {
      const verdict = verdictOf(adapter.id, now);
      if (verdict !== undefined) out.push(verdict);
    }
    return out;
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
      deps.setStatus(renderQuotaStatus(verdictsNow(now), now, settings.refreshMs, deps.theme?.()));
    } catch {
      // HUD 不可用不影响数据面。
    }
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
      const id = adapter.id;
      const now = clock.now();
      const ttl = effectiveTtl(id, now);
      const existing = snapshots.get(id);
      if (existing !== undefined) {
        // 窗口已过重置 ⇒ 读数已知过期（判定层已把该窗口视同过期，见 ladder 规则 0）：
        // 绕过 TTL 立即重拉，闸门/注入不再建立在重置前的旧数据上，直到新读数落地。
        // 在途去重照常兜住并发触发；可疑读数的退避不绕过（确认节奏不变）。零 timer。
        const resetElapsed = existing.windows.some((w) => w.resetAt !== undefined && w.resetAt <= now);
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
        if (disposed || snapshot === undefined || snapshot.provider !== id) return;
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
      return isQuotaProviderId(provider) ? verdictOf(provider, at) : undefined;
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
