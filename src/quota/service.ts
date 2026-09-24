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
 * - **零 setInterval/setTimeout**（D2：懒触发为主，不装任何 timer——测试用
 *   `FakeClock.pendingTimers === 0` 锁死）。
 * - 刷新落地后：观测重置（全部窗口跌幅 ≥ QUOTA_HYSTERESIS_PCT）⇒
 *   `demotions.clear` + 清该 provider 全部样本环；否则按 (provider, scope)
 *   追加样本；verdict level ≥ 2 ⇒ `demotions.mark`；最后写 HUD status 行。
 * - dispose（M3 评审修订，单一所有者、幂等）：`setStatus(undefined)` 恰一次；
 *   在途刷新落地后**拒写 status、拒改状态**；`QuotaStack.dispose()` 只是纯转发。
 */

import type { Clock } from "../core/clock.js";
import type { QuotaSettings } from "../config/settings.js";
import type { Millis } from "../core/types.js";
import type { DemotionStore } from "./demotion.js";
import { forecast, pushSample, type BurnSample } from "./forecast.js";
import { providerVerdict, QUOTA_HYSTERESIS_PCT, type LadderThresholds, type ProviderVerdict } from "./ladder.js";
import { renderQuotaStatus, type QuotaStatusTheme } from "./render.js";
import {
  isQuotaProviderId,
  type CredentialResolver,
  type FetchJson,
  type ProviderAdapter,
  type QuotaProviderId,
  type QuotaSnapshot,
  type QuotaWindowsSnapshot,
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
}

/** §5.3 ② 观测重置：新快照的全部窗口都比旧快照同 scope 跌 ≥ QUOTA_HYSTERESIS_PCT。 */
function isObservedReset(prev: QuotaSnapshot | undefined, next: QuotaWindowsSnapshot): boolean {
  if (prev === undefined || prev.kind !== "windows") return false;
  if (prev.windows.length === 0 || next.windows.length === 0) return false;
  for (const w of next.windows) {
    const old = prev.windows.find((p) => p.scope === w.scope);
    if (old === undefined) return false;
    if (w.usedPct > old.usedPct - QUOTA_HYSTERESIS_PCT) return false;
  }
  return true;
}

export function createQuotaService(deps: QuotaServiceDeps): QuotaService {
  const { settings, clock } = deps;
  const snapshots = new Map<QuotaProviderId, QuotaSnapshot>();
  const rings = new Map<string, readonly BurnSample[]>();
  const inflight = new Map<QuotaProviderId, Promise<void>>();
  const lastAttempt = new Map<QuotaProviderId, Millis>();
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
    let demoted = false;
    try {
      demoted = deps.demotions.get(id, now) !== undefined;
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

  /** HUD 行写入（R8：setStatus 可能来自陈旧 ctx，双探测 + try/catch 由注入方负责，这里再兜一层）。 */
  const writeStatus = (now: Millis): void => {
    if (disposed || deps.setStatus === undefined) return;
    try {
      deps.setStatus(renderQuotaStatus(verdictsNow(now), now, settings.refreshMs, deps.theme?.()));
    } catch {
      // HUD 不可用不影响数据面。
    }
  };

  /** 刷新落地：存快照 → 重置检测/样本环 → 降位标记 → HUD。调用方保证 disposed === false。 */
  const applySnapshot = (snapshot: QuotaSnapshot): void => {
    const id = snapshot.provider;
    const now = clock.now();
    const prev = snapshots.get(id);
    snapshots.set(id, snapshot);
    if (snapshot.kind === "windows") {
      if (isObservedReset(prev, snapshot)) {
        // §5.3 ②：观测重置 ⇒ 清降位 + 清该 provider 全部样本环（跨重置的斜率是垃圾）。
        try {
          deps.demotions.clear(id);
        } catch {
          // 契约永不抛，兜注入桩。
        }
        for (const w of snapshot.windows) rings.delete(ringKey(id, w.scope));
      } else {
        for (const w of snapshot.windows) {
          const key = ringKey(id, w.scope);
          rings.set(key, pushSample(rings.get(key) ?? [], { at: snapshot.fetchedAt, usedPct: w.usedPct }));
        }
      }
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
  };

  const refreshIfStale = (): void => {
    if (disposed) return;
    for (const adapter of deps.adapters) {
      const id = adapter.id;
      const now = clock.now();
      const existing = snapshots.get(id);
      if (existing !== undefined) {
        if (now - existing.fetchedAt < settings.refreshMs) continue; // TTL：快照未过期
      } else {
        // 无快照（从未成功或上次失败）：按上次尝试时间退避，失败的端点不被每轮 turn 撞击。
        const last = lastAttempt.get(id);
        if (last !== undefined && now - last < settings.refreshMs) continue;
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
