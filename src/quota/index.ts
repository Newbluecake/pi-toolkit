/**
 * Quota barrel + stack factory (docs/dev/quota/quota-plan.md §3.12 / §4.1).
 *
 * `createQuotaStack` 是 stack.ts 的唯一调用面：把 credentials / fetchJson /
 * adapters / demotion store / service / hint-state 组装成一个 `QuotaStack`。
 * `settings.quota.enabled === false` ⇒ 返回 `undefined`（stack 上 `quota` /
 * `quotaHint` 缺席，全特性一键回退，R11）。
 *
 * M3（评审修订）：`QuotaStack.dispose()` 是**纯转发**（`service.dispose()`）——
 * 所有清理（HUD `setStatus(undefined)`、在途防护、幂等标志）收进
 * `QuotaService.dispose()` 单一所有者；`/new` 双重 dispose 路径安全（幂等）。
 *
 * 注意：gate.ts（Pack E，并行施工）刻意不在本 barrel 里 re-export——等它
 * 合并后再补，避免跨包编译依赖。
 */

import type { Clock } from "../core/clock.js";
import type { QuotaSettings } from "../config/settings.js";
import { ADAPTERS, selectAdapters } from "./adapters/index.js";
import { createDroidAdapters, type DroidAdapterPair } from "./adapters/droid.js";
import { createBaselineStore, type BaselineStore } from "./baseline.js";
import { createCredentialResolver } from "./credentials.js";
import { createDemotionStore, type DemotionRecord, type DemotionStore } from "./demotion.js";
import { createFetchJson } from "./http.js";
import {
  createQuotaHintHook,
  QUOTA_AVAILABLE_ENTRY_TYPE,
  QUOTA_CUSTOM_TYPE,
  QUOTA_RECOVERY_INBOX_CAP,
  type QuotaAnnounceLatch,
  type QuotaHintDeps,
  type QuotaHintState,
} from "./hook.js";
import { createQuotaService, type QuotaModelView, type QuotaService, type QuotaServiceDeps } from "./service.js";
import type { QuotaStatusTheme } from "./render.js";
import type { ProviderVerdict, QuotaRecoveryEvent } from "./ladder.js";
import {
  DROID_QUOTA_IDS,
  isDroidQuotaId,
  isQuotaProviderId,
  type LadderLevel,
  type QuotaPoolPort,
  type QuotaProblem,
  type QuotaProviderId,
  type QuotaSnapshot,
} from "./types.js";

export interface QuotaStack {
  readonly service: QuotaService;
  readonly hintState: QuotaHintState;
  dispose(): void;
}

export interface QuotaStackInput {
  readonly settings: QuotaSettings;
  readonly clock: Clock;
  /** 由 stack.ts 注入 join(getAgentDir(), "quota-state.json")。 */
  readonly statePath: string;
  readonly setStatus?: ((text: string | undefined) => void) | undefined;
  /** HUD 主题 getter（stack.ts 注入 readQuotaStatusTheme(ctx)）；缺省纯文本。 */
  readonly theme?: (() => QuotaStatusTheme | undefined) | undefined;
  readonly warn?: ((message: string) => void) | undefined;
  /**
   * droid 池输入（quota-plan r2 §2.5，**P5 唯一要接的线**）：externalAgents.droid
   * 启用时由 stack.ts 供给。缺席 ⇒ 不构造 droid 适配器：零网络、零凭据读取、零告警
   * （D11），kimi/zai 输出字节不变。
   */
  readonly droid?:
    | {
        readonly pools: () => QuotaPoolPort | undefined;
        /** Late-bound external-provider health port; missing preserves standalone quota behavior. */
        readonly onAvailability?: ((problem: QuotaProblem | undefined) => void) | undefined;
      }
    | undefined;
}

/** `settings.quota.providers` 白名单解析结果：`droid` token 展开成两个池的开关位。 */
interface ProviderWhitelist {
  readonly ids: readonly QuotaProviderId[];
  /** 白名单里有 `droid`（或单写的 `droid-standard` / `droid-core`）token。 */
  readonly droid: boolean;
}

/** `settings.quota.providers`（逗号分隔白名单）→ 受控 id 列表；未知 id 静默忽略，空串 = 空。 */
function parseProviderWhitelist(raw: string): ProviderWhitelist {
  const out: QuotaProviderId[] = [];
  let droid = false;
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id === "droid") {
      droid = true; // token `droid` 展开成两个池（D2）：两个虚拟 id 都进白名单，否则 selectAdapters 会把对子滤光
      for (const pool of DROID_QUOTA_IDS) if (!out.includes(pool)) out.push(pool);
      continue;
    }
    if (isDroidQuotaId(id)) {
      droid = true; // 顺带接受单写 droid-standard / droid-core
      if (!out.includes(id)) out.push(id);
      continue;
    }
    if (isQuotaProviderId(id) && !out.includes(id)) out.push(id);
  }
  return { ids: out, droid };
}

/** stack.ts 的唯一调用面。settings.quota.enabled=false 时返回 undefined。 */
export function createQuotaStack(input: QuotaStackInput): QuotaStack | undefined {
  const { settings, clock, statePath } = input;
  if (!settings.enabled) return undefined;

  const warn = input.warn;
  const credentials = createCredentialResolver(warn === undefined ? {} : { warn });
  const fetchJson = createFetchJson({
    timeoutMs: settings.requestTimeoutMs,
    ...(warn === undefined ? {} : { warn }),
  });
  const whitelist = parseProviderWhitelist(settings.providers);
  // droid 池（D2/D11）：input.droid 存在且白名单含 droid ⇒ 构造适配器对子（isActive
  // 晚绑定 P5 端口 getter，端口缺席 ⇒ inactive ⇒ 不读凭据不发请求）；input.droid
  // 存在但白名单不含 droid ⇒ warnOnce 一次（不构造）。input.droid 缺席 ⇒ 零副作用。
  let droidPair: DroidAdapterPair | undefined;
  let droidPools: (() => QuotaPoolPort | undefined) | undefined;
  if (input.droid !== undefined) {
    if (whitelist.droid) {
      const droidInput = input.droid;
      droidPair = createDroidAdapters({
        isActive: () => droidInput.pools() !== undefined,
        onAvailability: (problem) => droidInput.onAvailability?.(problem),
        ...(warn === undefined ? {} : { warn }),
      });
      droidPools = droidInput.pools;
    } else if (warn !== undefined) {
      try {
        warn(
          '[quota] droid is enabled (externalAgents.droid) but not in quota.providers — add "droid" to quota.providers',
        );
      } catch {
        // 日志通道不能破坏装配。
      }
    }
  }
  const adapters = selectAdapters(whitelist.ids, droidPair);
  const demotions = createDemotionStore({
    path: statePath,
    now: () => clock.now(),
    ...(warn === undefined ? {} : { warn }),
  });
  // 可疑读数基线（2026-10-15 现场事件后继包）：与 demotions 共享 quota-state.json，
  // 两个 store 各自保留对方顶层键（读改写）；重启后基线播种 classifyDrop 的比对。
  const baselines = createBaselineStore({
    path: statePath,
    now: () => clock.now(),
    ...(warn === undefined ? {} : { warn }),
  });

  // 额度恢复播报的接缝（service 经事件、hook 层凭闩锁判断）：hintState 与 service
  // 同在此构造，收件箱与 latches 同生命周期；「曾播报」语义与 Minor 1/2 回滚都留在
  // hook 层，service 保持注入无关。上限只防积压（见 QUOTA_RECOVERY_INBOX_CAP）。
  const hintState: QuotaHintState = {
    enabled: true,
    tickStepPercent: settings.tickStepPercent,
    repeatMs: settings.repeatMs,
    minIntervalMs: settings.minIntervalMs,
    display: settings.display,
    latches: new Map<string, QuotaAnnounceLatch>(),
    lastSentAt: 0,
    recoveries: [],
    availableAnnounced: new Set<string>(),
  };
  const pushRecovery = (event: QuotaRecoveryEvent): void => {
    if (hintState.recoveries.length >= QUOTA_RECOVERY_INBOX_CAP) hintState.recoveries.shift();
    hintState.recoveries.push(event);
  };

  const service = createQuotaService({
    settings,
    clock,
    adapters,
    credentials,
    fetchJson,
    demotions,
    baselines,
    onObservedReset: pushRecovery,
    // droid 凭据缺失披露（2026-10-19 拍板）：resolver 状态面 → service → HUD/status。
    droidCredentialMissing: credentials.droidKeyMissing,
    ...(droidPools === undefined ? {} : { pools: droidPools }),
    ...(input.setStatus === undefined ? {} : { setStatus: input.setStatus }),
    ...(input.theme === undefined ? {} : { theme: input.theme }),
    ...(warn === undefined ? {} : { warn }),
  });

  // M3：纯转发——一切清理收进 QuotaService.dispose() 单一所有者。
  return {
    service,
    hintState,
    dispose: () => service.dispose(),
  };
}

export type {
  BaselineStore,
  DemotionRecord,
  DemotionStore,
  LadderLevel,
  ProviderVerdict,
  QuotaHintDeps,
  QuotaHintState,
  QuotaModelView,
  QuotaPoolPort,
  QuotaProblem,
  QuotaProviderId,
  QuotaRecoveryEvent,
  QuotaService,
  QuotaServiceDeps,
  QuotaSnapshot,
};
export {
  ADAPTERS,
  QUOTA_AVAILABLE_ENTRY_TYPE,
  QUOTA_CUSTOM_TYPE,
  createBaselineStore,
  createCredentialResolver,
  createDemotionStore,
  createDroidAdapters,
  createFetchJson,
  createQuotaHintHook,
  createQuotaService,
  selectAdapters,
};
export { createCatalogPoolPort, derivePool } from "./pools.js";
export type { CatalogModelLike, CatalogPoolPort } from "./pools.js";
export { DROID_PROVIDER, DROID_QUOTA_IDS, isDroidQuotaId } from "./types.js";
export type { DroidQuotaProviderId, QuotaPoolId, QuotaBillingInfo } from "./types.js";
export { droidCliLoginPresent } from "./credentials.js";
export type { DroidCredentialState } from "./credentials.js";
