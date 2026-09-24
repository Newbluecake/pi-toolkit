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
import { createCredentialResolver } from "./credentials.js";
import { createDemotionStore, type DemotionRecord, type DemotionStore } from "./demotion.js";
import { createFetchJson } from "./http.js";
import {
  createQuotaHintHook,
  QUOTA_CUSTOM_TYPE,
  QUOTA_RECOVERY_INBOX_CAP,
  type QuotaAnnounceLatch,
  type QuotaHintDeps,
  type QuotaHintState,
} from "./hook.js";
import { createQuotaService, type QuotaService, type QuotaServiceDeps } from "./service.js";
import type { QuotaStatusTheme } from "./render.js";
import type { ProviderVerdict, QuotaRecoveryEvent } from "./ladder.js";
import { isQuotaProviderId, type LadderLevel, type QuotaProviderId, type QuotaSnapshot } from "./types.js";

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
}

/** `settings.quota.providers`（逗号分隔白名单）→ 受控 id 列表；未知 id 静默忽略，空串 = 空。 */
function parseProviderWhitelist(raw: string): readonly QuotaProviderId[] {
  const out: QuotaProviderId[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (isQuotaProviderId(id)) out.push(id);
  }
  return out;
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
  const adapters = selectAdapters(parseProviderWhitelist(settings.providers));
  const demotions = createDemotionStore({
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
    onObservedReset: pushRecovery,
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
  DemotionRecord,
  DemotionStore,
  LadderLevel,
  ProviderVerdict,
  QuotaHintDeps,
  QuotaHintState,
  QuotaProviderId,
  QuotaRecoveryEvent,
  QuotaService,
  QuotaServiceDeps,
  QuotaSnapshot,
};
export {
  ADAPTERS,
  QUOTA_CUSTOM_TYPE,
  createCredentialResolver,
  createDemotionStore,
  createFetchJson,
  createQuotaHintHook,
  createQuotaService,
  selectAdapters,
};
