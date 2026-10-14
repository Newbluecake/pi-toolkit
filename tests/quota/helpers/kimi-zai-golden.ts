/**
 * kimi/zai golden recording (P7 「kimi/zai 逐字节不变」的双保险之一，
 * 参照 compact-hint golden 先例）：
 *
 * `recordKimiZaiGolden()` 在**未改动的实现**上被录制一次，落盘为
 * `tests/fixtures/quota-kimi-zai-golden.json`，此后永不重新生成（P7 及之后
 * 对 quota 模块的任何改动都必须让本录制逐字节复现）。
 *
 * 覆盖对象（quota-plan r2 §11 第一行）：
 * - `providerVerdict` 的 JSON（kimi 周耗尽陷阱 / zai 同池 / L1/L2/L3 / stale /
 *   降位地板 / reset-elapsed / week forecast-before-reset / forecast-eta）；
 * - `renderQuotaStatus` 纯文本版与主题版；
 * - `buildQuotaMessage` / `buildQuotaTickText` / `buildQuotaWarnText` /
 *   `buildQuotaBlockText` / `buildQuotaRecoveryTexts` / `buildQuotaAvailableTexts`；
 * - `evaluateQuotaGate` 的 message（不带新 deps、带新 deps 但非 droid 模型——
 *   两者都等于旧输出）与 `pickAlternatives` / `quotaAnnotation` /
 *   `alternativesAdvice`；
 * - `createQuotaHintHook` 发出的 content + details；
 * - `projectQuota` + `quotaFingerprint`。
 *
 * 固定时钟 + 固定 TZ（测试文件顶部 `process.env.TZ = "Asia/Shanghai"`，
 * 本模块所有 Date 调用都在录制函数执行时发生）。
 */

import { evaluateQuotaGate, pickAlternatives, quotaAnnotation } from "../../../src/quota/gate.js";
import { createQuotaHintHook, type QuotaHintState } from "../../../src/quota/hook.js";
import { DEFAULT_THRESHOLDS_BY_WINDOW, providerVerdict, type ProviderVerdict } from "../../../src/quota/ladder.js";
import {
  alternativesAdvice,
  buildQuotaAvailableTexts,
  buildQuotaBlockText,
  buildQuotaMessage,
  buildQuotaRecoveryTexts,
  buildQuotaTickText,
  buildQuotaWarnText,
  renderQuotaStatus,
  type AlternativeSelection,
  type QuotaStatusTheme,
} from "../../../src/quota/render.js";
import type { QuotaSnapshot, QuotaWindow, WindowScope } from "../../../src/quota/types.js";
import type { QuotaRecoveryEvent } from "../../../src/quota/ladder.js";
import { projectQuota, quotaFingerprint } from "../../../src/web-hub/agent/quota-sampler.js";
import type { ModelCandidate } from "../../../src/config/model-hint.js";

/** 固定 now：2026-10-14 12:00:00 Asia/Shanghai（UTC+8）。 */
export const GOLDEN_NOW = Date.UTC(2026, 9, 14, 4, 0, 0);

const HOUR = 3_600_000;

function snapshot(provider: "zai-coding-cn" | "zai" | "kimi-coding", windows: readonly QuotaWindow[]): QuotaSnapshot {
  return { provider, kind: "windows", windows, fetchedAt: GOLDEN_NOW };
}

const thresholds = (scope: WindowScope) => DEFAULT_THRESHOLDS_BY_WINDOW[scope];

function judge(
  snap: QuotaSnapshot,
  input: {
    etaMs?: Partial<Record<WindowScope, number | undefined>>;
    staleAfterMs?: number;
    demoted?: boolean;
    demotedUntil?: number;
    now?: number;
  } = {},
): ProviderVerdict {
  return providerVerdict(snap, {
    now: input.now ?? GOLDEN_NOW,
    thresholds,
    staleAfterMs: input.staleAfterMs ?? HOUR,
    etaOf: (scope) => input.etaMs?.[scope],
    demoted: input.demoted ?? false,
    ...(input.demotedUntil === undefined ? {} : { demotedUntil: input.demotedUntil }),
  });
}

export interface GoldenRecording {
  readonly meta: { readonly now: number; readonly tz: string; readonly note: string };
  readonly verdicts: Record<string, ProviderVerdict>;
  readonly renders: Record<string, unknown>;
  readonly gate: Record<string, unknown>;
  readonly hook: readonly { customType: string; content: string; display: boolean; details: unknown }[];
  readonly sampler: { readonly wire: unknown; readonly fingerprint: string };
}

export function recordKimiZaiGolden(): GoldenRecording {
  const now = GOLDEN_NOW;

  // ---- verdicts ----------------------------------------------------------
  // kimi 周耗尽陷阱：5h 8% / week 100%（带未来 resetAt）⇒ L3。
  const kimiTrap = judge(
    snapshot("kimi-coding", [
      { scope: "5h", usedPct: 8, resetAt: now + 2 * HOUR },
      { scope: "week", usedPct: 100, resetAt: now + 3 * 24 * HOUR + 4 * HOUR },
    ]),
  );
  // zai 同池对（L1），用于同池去重/合并。
  const zaiCnL1 = judge(
    snapshot("zai-coding-cn", [
      { scope: "5h", usedPct: 55, resetAt: now + 90 * 60_000 },
      { scope: "week", usedPct: 10, resetAt: now + 5 * 24 * HOUR },
    ]),
  );
  const zaiL1 = judge(
    snapshot("zai", [
      { scope: "5h", usedPct: 55, resetAt: now + 90 * 60_000 },
      { scope: "week", usedPct: 10, resetAt: now + 5 * 24 * HOUR },
    ]),
  );
  const zaiL2 = judge(snapshot("zai", [{ scope: "5h", usedPct: 80, resetAt: now + HOUR }]));
  const kimiL3Pct = judge(snapshot("kimi-coding", [{ scope: "5h", usedPct: 95, resetAt: now + 30 * 60_000 }]));
  const stale = judge(snapshot("zai-coding-cn", [{ scope: "5h", usedPct: 60 }]), {
    now: now + HOUR + 1, // fetchedAt = GOLDEN_NOW ⇒ 快照年龄 > staleAfterMs
  });
  const demotionFloor = judge(
    snapshot("kimi-coding", [
      { scope: "5h", usedPct: 10, resetAt: now + 2 * HOUR },
      { scope: "week", usedPct: 5, resetAt: now + 6 * 24 * HOUR },
    ]),
    { demoted: true, demotedUntil: now + 3 * HOUR },
  );
  const resetElapsed = judge(snapshot("zai", [{ scope: "week", usedPct: 99, resetAt: now - 1_000 }]));
  const forecastBeforeReset = judge(snapshot("zai", [{ scope: "week", usedPct: 60, resetAt: now + 2 * HOUR }]), {
    etaMs: { week: HOUR }, // now + eta < resetAt ⇒ 规则 3b 抬 L2
  });
  const forecastEta = judge(snapshot("zai-coding-cn", [{ scope: "5h", usedPct: 40, resetAt: now + 4 * HOUR }]), {
    etaMs: { "5h": 600_000 }, // < l3EtaMs ⇒ 规则 3a 抬 L3
  });

  const verdicts: Record<string, ProviderVerdict> = {
    "kimi-trap": kimiTrap,
    "zai-cn-l1": zaiCnL1,
    "zai-l1": zaiL1,
    "zai-l2": zaiL2,
    "kimi-l3-pct": kimiL3Pct,
    stale,
    "demotion-floor": demotionFloor,
    "reset-elapsed": resetElapsed,
    "forecast-before-reset": forecastBeforeReset,
    "forecast-eta": forecastEta,
  };

  // ---- renders -----------------------------------------------------------
  const theme: QuotaStatusTheme = { fg: (color, text) => `<${color}>${text}</${color}>` };
  const hudRows = [kimiTrap, zaiCnL1, zaiL1, demotionFloor];
  const altSub: AlternativeSelection = { providers: ["kimi-coding", "zai-coding-cn"], subscription: true };
  const altPaygo: AlternativeSelection = { providers: ["cloudrouter-anthropic"], subscription: false };
  const recoveryEvent: QuotaRecoveryEvent = {
    provider: "kimi-coding",
    resetScopes: new Set<WindowScope>(["week"]),
    verdict: judge(
      snapshot("kimi-coding", [
        { scope: "5h", usedPct: 12, resetAt: now + 2 * HOUR },
        { scope: "week", usedPct: 3, resetAt: now + 6 * 24 * HOUR },
      ]),
    ),
    gateBlocked: false,
    at: now,
  };
  const renders: Record<string, unknown> = {
    statusPlain: renderQuotaStatus(hudRows, now, 600_000),
    statusThemed: renderQuotaStatus(hudRows, now, 600_000, theme),
    statusStale: renderQuotaStatus([stale], now + HOUR + 1, 600_000),
    statusEmpty: renderQuotaStatus([], now, 600_000) ?? null,
    tick: buildQuotaTickText([zaiCnL1, zaiL1], now),
    message: buildQuotaMessage(
      [
        { verdict: zaiCnL1, alternatives: { providers: [], subscription: true } },
        { verdict: zaiL2, alternatives: altSub },
        { verdict: kimiTrap, alternatives: altSub },
      ],
      now,
    ),
    messageMergedL3: buildQuotaMessage(
      [
        { verdict: kimiTrap, alternatives: altSub },
        { verdict: kimiL3Pct, alternatives: altSub },
      ],
      now,
    ),
    warn: buildQuotaWarnText(zaiL2, now),
    warnDemotionFloor: buildQuotaWarnText(demotionFloor, now),
    block: buildQuotaBlockText(kimiTrap, altSub, now),
    blockPaygo: buildQuotaBlockText(kimiTrap, altPaygo, now),
    recovery: buildQuotaRecoveryTexts([recoveryEvent], now),
    available: buildQuotaAvailableTexts([zaiCnL1, zaiL1]),
    adviceObjectSub: alternativesAdvice(altSub),
    adviceObjectPaygo: alternativesAdvice(altPaygo),
    adviceArray: alternativesAdvice(["kimi-coding", "zai"]),
    adviceEmpty: alternativesAdvice({ providers: [], subscription: true }),
  };

  // ---- gate --------------------------------------------------------------
  const candidates: readonly ModelCandidate[] = [
    { provider: "kimi-coding", id: "kimi-for-coding" },
    { provider: "zai-coding-cn", id: "glm-5.3" },
    { provider: "zai", id: "glm-5.3" },
    { provider: "cloudrouter-anthropic", id: "claude-sonnet-5" },
  ];
  const verdictMap = new Map<string, ProviderVerdict>([
    ["kimi-coding", kimiTrap],
    ["zai-coding-cn", zaiCnL1],
    ["zai", zaiL1],
  ]);
  const gateDeps = {
    verdictFor: (p: string) => verdictMap.get(p),
    available: () => candidates,
    blockAtLevel: 3 as const,
    now,
  };
  const blocked = evaluateQuotaGate({ provider: "kimi-coding", id: "kimi-for-coding" }, gateDeps);
  // P7 之后 gate 会新增 modelView/poolAlternatives 两个可选 deps；非 droid 模型
  // 必须走旧路径（录制期实现还没有这两个字段——结构化类型允许变量携带多余键）。
  const newDepsNoop = {
    modelView: () => undefined,
    poolAlternatives: () => [] as readonly string[],
  };
  const blockedWithNewDeps = evaluateQuotaGate({ provider: "kimi-coding", id: "kimi-for-coding" }, {
    ...gateDeps,
    ...newDepsNoop,
  } as unknown as typeof gateDeps);
  const gatePassL0 = evaluateQuotaGate({ provider: "zai", id: "glm-5.3" }, gateDeps) ?? null;
  const gatePassUnknown =
    evaluateQuotaGate({ provider: "cloudrouter-anthropic", id: "claude-sonnet-5" }, gateDeps) ?? null;
  const gate: Record<string, unknown> = {
    blocked,
    blockedWithNewDeps,
    gatePassL0,
    gatePassUnknown,
    picked: pickAlternatives("kimi-coding", gateDeps, 3),
    pickedWithNewDeps: pickAlternatives(
      "kimi-coding",
      { ...gateDeps, ...newDepsNoop } as unknown as typeof gateDeps,
      3,
    ),
    annotationL1: quotaAnnotation(candidates[1]!, (p) => verdictMap.get(p)),
    annotationL3: quotaAnnotation(candidates[0]!, (p) => verdictMap.get(p)),
    annotationDemoted: quotaAnnotation(candidates[0]!, () => demotionFloor),
    annotationL0: quotaAnnotation(candidates[3]!, (p) => verdictMap.get(p)) ?? null,
  };

  // ---- hook --------------------------------------------------------------
  const sent: { customType: string; content: string; display: boolean; details: unknown }[] = [];
  const hookState: QuotaHintState = {
    enabled: true,
    tickStepPercent: 10,
    repeatMs: 1_800_000,
    minIntervalMs: 300_000,
    display: true,
    latches: new Map(),
    lastSentAt: 0,
    recoveries: [],
    availableAnnounced: new Set<string>(),
  };
  let hookNow = now;
  let currentVerdicts: readonly ProviderVerdict[] = [zaiCnL1, zaiL1];
  const hook = createQuotaHintHook({
    state: () => hookState,
    verdicts: () => currentVerdicts,
    refresh: () => undefined,
    sendMessage: (message) => {
      sent.push({
        customType: message.customType,
        content: message.content,
        display: message.display,
        details: message.details,
      });
    },
    now: () => hookNow,
    alternatives: () => altSub,
  });
  const hookCtx = { mode: "interactive" } as never;
  hook({}, hookCtx); // 首次 L1 播报（zai 同池合并）+ 无可用播报（L1 不算「低于 L1」）
  currentVerdicts = [
    judge(
      snapshot("zai-coding-cn", [
        { scope: "5h", usedPct: 68, resetAt: now + 90 * 60_000 },
        { scope: "week", usedPct: 10, resetAt: now + 5 * 24 * HOUR },
      ]),
    ),
  ];
  hookNow = now + 60_000;
  hook({}, hookCtx); // 网格前进 55→68（step 10 ⇒ 50→60）再播报一次
  currentVerdicts = [kimiTrap];
  hookNow = now + 120_000;
  hook({}, hookCtx); // 新 provider L3（绕过 minInterval）
  const hookMessages = sent;

  // ---- sampler -----------------------------------------------------------
  const wire = projectQuota([kimiTrap, zaiCnL1, zaiL1, demotionFloor], now);

  return {
    meta: {
      now,
      tz: "Asia/Shanghai",
      note: "Recorded on the pre-P7 implementation. NEVER regenerate — P7 changes must reproduce these bytes.",
    },
    verdicts,
    renders,
    gate,
    hook: hookMessages,
    sampler: { wire, fingerprint: quotaFingerprint(wire) },
  };
}
