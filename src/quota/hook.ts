/**
 * turn_end quota injection hook (docs/dev/quota/quota-plan.md §3.10 / §5.1 /
 * D3 / D4): the compact-hint-shaped channel for quota verdicts.
 *
 * - 注入通道照抄 compact-hint：`sendMessage(..., { triggerTurn: false })`——
 *   只进上下文、不额外起一轮模型调用（零工具调用是本特性的定义性约束）。
 * - **先读后刷**：同步读缓存出判定并注入，再 fire-and-forget
 *   `refresh()`（本轮用旧值，新值给下一轮）；顺序由测试锁死。
 * - M1（评审修订）：stale 快照不进注入流——不闩锁、不复读（stale 时闸门放行
 *   （R5），任何「会被拦下」的承诺都是假的，宁可静默；stale 只进 HUD）。
 * - 三闸 shouldAnnounce（D4）：等级抬升 / usedPct 网格前进 / L3 复读；
 *   L0 清闩锁。每轮**至多一条**合并消息（所有 provider 拼一个块）。
 * - 闩锁回滚（Minor 1/2）：被 `minIntervalMs` 吞掉的一步、以及 send 失败的
 *   一轮，都把闩锁滚回本轮前的值（首次进入者用 `delete` 而非 set 脏值）——
 *   「被吞掉的那一次网格前进」永远不会再播报是 bug。
 * - L3 与恢复播报绕过全局最小间隔（两者都直接改变本轮派单决策；恢复事件
 *   consume-once + 窗口重置天然数小时间隔，无刷屏面）。
 * - 额度恢复播报：service 在观测重置（classifyDrop 认定且快照被接受）时把
 *   QuotaRecoveryEvent 推进 state.recoveries；hook 每 turn_end 排空，仅在
 *   provider 曾真播报过（闩锁存在）时注入恢复块（含当前读数与闸门状态），
 *   同轮抑制该 provider 的常规块（每次观测重置至多一条）；send 失败 ⇒ 闩锁
 *   回滚 + 事件回队重试。
 * - 可用播报（B 方案，2026-10-04 用户拍板）：本栈首次观测到窗口型 provider
 *   真实读数低于 L1 ⇒ 一次性注入「订阅可用」——「无 [quota] 行 ≠ 没额度」
 *   盲区的正向消解。每 provider 每栈至多一条；stale / reset-elapsed（读数
 *   不真）与 demoted（刻意停放）都不播；send 失败 ⇒ 从已播集合移除重试。
 * - `sendMessage` / `verdicts` / `refresh` 抛被 catch：turn_end 不可拖垮。
 * - print/json 模式直接 return（子会话惰性，R12——钩子本身只在主会话注册，
 *   此门是双保险）。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Millis } from "../core/types.js";
import {
  gridStep,
  isForecastSoftVerdict,
  QUOTA_HYSTERESIS_PCT,
  type ProviderVerdict,
  type QuotaRecoveryEvent,
  type WindowVerdict,
} from "./ladder.js";
import {
  buildQuotaAvailableTexts,
  buildQuotaMessage,
  buildQuotaRecoveryTexts,
  type AlternativeSelection,
} from "./render.js";
import type { LadderLevel } from "./types.js";

export const QUOTA_CUSTOM_TYPE = "subagent:quota";

/**
 * 可用播报持久化条目（2026-10-23 拍板，跨 /reload 去重）：custom entry type（不进
 * LLM 上下文）。每次成功播报「订阅可用」后写入全量键集；栈重建（/reload / resume）
 * 后从 getBranch 读回最后一条，同一窗口周期内不重发。读不到/损坏 ⇒ 回落现行为
 * （可重报），不抛错。
 */
export const QUOTA_AVAILABLE_ENTRY_TYPE = "subagent:quota-avail";

/** 持久化键容量上限（防积压保险：正常节奏下每 provider 每窗口周期一个键）。 */
export const QUOTA_AVAILABLE_KEY_CAP = 64;

/**
 * 可用播报去重键（provider + 当前各窗口 resetAt 指纹）：窗口重置 ⇒ resetAt 变化
 * ⇒ 键变 ⇒ 允许再报一次；同一周期内（含 /reload 重建栈）键不变 ⇒ 不重发。
 */
export function quotaAvailableKey(provider: string, windows: readonly WindowVerdict[]): string {
  const fp = windows
    .map((w) => `${w.scope}:${w.resetAt === undefined || !Number.isFinite(w.resetAt) ? "?" : w.resetAt}`)
    .sort()
    .join("|");
  return `${provider}@${fp}`;
}

/** 读回持久化条目：非数组 / 非字符串成员 ⇒ undefined（调用方回落现行为，可重报）。 */
export function parseAvailableKeys(data: unknown): readonly string[] | undefined {
  const keys = (data as { keys?: unknown } | undefined)?.keys;
  if (!Array.isArray(keys)) return undefined;
  const out: string[] = [];
  for (const k of keys) {
    if (typeof k === "string" && k.length > 0 && k.length <= 256) out.push(k);
    if (out.length >= QUOTA_AVAILABLE_KEY_CAP) break;
  }
  return out;
}

/** 从会话分支读回可用播报键（仅取最后一条条目，每个 state 实例一次）；静默失败。 */
function restoreAvailableKeys(state: QuotaHintState, ctx: ExtensionContext): void {
  try {
    const branch =
      typeof ctx.sessionManager?.getBranch === "function" ? (ctx.sessionManager.getBranch() as unknown[]) : undefined;
    if (!Array.isArray(branch)) return;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as { type?: string; customType?: string; data?: unknown } | undefined;
      if (entry?.type !== "custom" || entry.customType !== QUOTA_AVAILABLE_ENTRY_TYPE) continue;
      const keys = parseAvailableKeys(entry.data);
      if (keys !== undefined) for (const k of keys) state.availableAnnounced.add(k);
      return;
    }
  } catch {
    /* 读不到 / 损坏 ⇒ 回落现行为（可重报），不拖垮 turn_end */
  }
}

/** 恢复收件箱容量上限（createQuotaStack 推入时截断丢最旧）——只是防积压保险：
 * 正常节奏下每窗口每 provider 数小时至多一条；钩子关闭/ print 模式下无人排空也不膨胀。 */
export const QUOTA_RECOVERY_INBOX_CAP = 16;

export interface QuotaAnnounceLatch {
  level: LadderLevel;
  step: number;
  at: Millis;
  usedPct: number;
  /** turn_end sequence number at the announce (2026-10-28 L1 turn cooldown). Absent on latches
   *  written before the field existed ⇒ treated as "long ago" (announce is allowed). */
  turn?: number;
}

/** 会话级可变状态，挂在 Stack 上（每次 session_start 重建；无模块级状态）。 */
export interface QuotaHintState {
  readonly enabled: boolean;
  readonly tickStepPercent: number;
  readonly repeatMs: Millis;
  readonly minIntervalMs: Millis;
  /** L1 turn cooldown: a grid step alone is not enough at L1 — it must also be at least this
   *  many turn_ends since the last announce (0 = off, grid-only, the pre-2026-10-28 rule). */
  readonly l1MinTurns: number;
  /** turn_end counter, monotone per stack (the unit `l1MinTurns` is measured in). */
  turns: number;
  readonly display: boolean;
  /** provider → 上次播报的闩锁。 */
  readonly latches: Map<string, QuotaAnnounceLatch>;
  lastSentAt: Millis;
  /**
   * service → hook 的恢复事件收件箱（额度恢复播报）：service 的 onObservedReset
   * 经 createQuotaStack 推入，hook 每 turn_end 排空（consume-once，不在 hook 里
   * 判定门槛的能否重试——send 失败时回队，见下方回滚路径）。与 latches 同生命周期。
   */
  readonly recoveries: QuotaRecoveryEvent[];
  /** 可用播报（B 方案）：本栈已播报过「订阅可用」的 provider——每 provider
   * 每栈至多一条；send 失败时从集合移除（与闩锁回滚同路径），下一轮重试。 */
  readonly availableAnnounced: Set<string>;
}

export interface QuotaHintDeps {
  readonly state: () => QuotaHintState | undefined;
  readonly verdicts: () => readonly ProviderVerdict[];
  readonly refresh: () => void;
  readonly sendMessage: (
    message: { customType: string; content: string; display: boolean; details: unknown },
    options: { triggerTurn: false },
  ) => void;
  readonly now?: (() => Millis) | undefined;
  /**
   * 可用播报持久化（跨 /reload 去重）：发送成功且本轮含可用播报时以全量键集回调；
   * 缺席（测试/旧接线）⇒ 仅栈内去重（现行为）。
   */
  readonly persistAvailable?: ((keys: readonly string[]) => void) | undefined;
  /**
   * 注入：provider → 替代 provider 列表与 tier 信息（Pack A 接线時用 gate.ts 的 `pickAlternatives` 供给）。
   * 缺省 `{ providers: [], subscription: true }`，render 层回落到「无替代候选」句式。
   */
  readonly alternatives?: ((provider: string) => AlternativeSelection) | undefined;
}

/**
 * 防噪音判定（§5.4，纯函数，单测直打不经钩子）：
 * 闸① 等级抬升；闸② 网格前进；闸③ L3 复读（L2 纯提示不复读）。重新武装：等级下降且百分比
 * 真实回落 ≥ QUOTA_HYSTERESIS_PCT（窗口重置 ⇒ 旧闩锁作废）。
 */
export function shouldAnnounce(
  verdict: ProviderVerdict,
  latch: QuotaAnnounceLatch | undefined,
  input: {
    readonly now: Millis;
    readonly tickStepPercent: number;
    readonly repeatMs: Millis;
    /** turn_end counter for this stack (see `QuotaHintState.turns`). */
    readonly turn?: number;
    /** L1 turn cooldown; 0/undefined = grid only (legacy). */
    readonly l1MinTurns?: number;
  },
): { readonly announce: boolean; readonly next: QuotaAnnounceLatch } {
  // provider 的代表百分比：全部窗口取最高（余额型无窗口 ⇒ 0）。
  let pct = 0;
  for (const w of verdict.windows) {
    if (w.usedPct > pct) pct = w.usedPct;
  }
  const step = gridStep(pct, input.tickStepPercent);
  const next: QuotaAnnounceLatch = {
    level: verdict.level,
    step,
    at: input.now,
    usedPct: pct,
    ...(input.turn === undefined ? {} : { turn: input.turn }),
  };

  if (latch === undefined) return { announce: true, next }; // 首次进入 L>=1

  // 重新武装：等级下降 + 百分比真实回落 ⇒ 窗口重置，闩锁作废。
  if (verdict.level < latch.level && pct <= latch.usedPct - QUOTA_HYSTERESIS_PCT) {
    return { announce: verdict.level >= 1, next };
  }

  if (verdict.level > latch.level) return { announce: true, next }; // 闸① 等级抬升（不受轮次冷却）
  if (step > latch.step) {
    // 闸② 网格前进。L1 额外要求轮次冷却（2026-10-28 用户：「L1 还要考虑上一次播报过去了多少轮次」）：
    // 短会话里连跨几档不该连报几条；被吞掉的那一步不丢——闩锁不前进，等冷却到期后重算
    // `step > latch.step` 仍然成立，下一轮就补报（与 minInterval 的回滚语义一致）。
    if (verdict.level === 1 && (input.l1MinTurns ?? 0) > 0) {
      const since = input.turn !== undefined && latch.turn !== undefined ? input.turn - latch.turn : Infinity;
      if (since < (input.l1MinTurns ?? 0)) return { announce: false, next: latch };
    }
    return { announce: true, next };
  }
  // 闸③ 复读只给 L3：L2 是纯提示（订阅优先用完），复读只会刷屏。
  if (verdict.level >= 3 && input.now - latch.at >= input.repeatMs) return { announce: true, next };
  return { announce: false, next: latch };
}

/**
 * 滞回判定（2026-10-23 拍板，纯函数）：provider 等级回到 0 是否**仅**因预测消失——
 * windows 的 reason 不再是 forecast-*（预测还在就不会是 L0），且 pct 相对闩锁的
 * 回落 < QUOTA_HYSTERESIS_PCT（真实回落 ≥ 滞回阈值视同窗口重置，由调用方清闩锁）。
 * true ⇒ 调用方保留闩锁（不重报、不触发「订阅可用」）。reset-elapsed 由调用方在
 * 更早处 continue（读数不真，与滞回正交）。
 */
export function isForecastDrop(verdict: ProviderVerdict, latch: QuotaAnnounceLatch): boolean {
  if (verdict.windows.some((w) => w.reason === "forecast-before-reset" || w.reason === "forecast-eta")) return false;
  let pct = 0;
  for (const w of verdict.windows) if (w.usedPct > pct) pct = w.usedPct;
  return pct > latch.usedPct - QUOTA_HYSTERESIS_PCT;
}

export function createQuotaHintHook(deps: QuotaHintDeps): (event: unknown, ctx: ExtensionContext) => void {
  const now = deps.now ?? (() => Date.now());
  // 可用播报持久化（跨 /reload 去重）：每个 state 实例（每次 session_start 重建）
  // 首次使用时从会话分支读回；仅在本轮真正播报过可用后才写（条目携带全量键集，
  // 读回取最后一条，天然最后一次写入胜出）。
  let restoredFor: QuotaHintState | undefined;
  let lastPersistedKeys: string | undefined;
  return (_event: unknown, ctx: ExtensionContext): void => {
    // ① 模式门：子会话是 print 模式，派单信息对它毫无意义（与 compact-hint 逐字同款）。
    if (ctx.mode === "print" || ctx.mode === "json") return;
    const state = deps.state();
    if (state === undefined || !state.enabled) return;

    const t = now();
    state.turns++;

    // ②.5 可用播报读回（跨 /reload 去重）：栈重建后的首轮从会话分支取回已播键。
    if (restoredFor !== state) {
      restoredFor = state;
      restoreAvailableKeys(state, ctx);
    }

    // ② 同步读缓存判定（永不 await、永不发请求）。
    let verdicts: readonly ProviderVerdict[] = [];
    try {
      verdicts = deps.verdicts();
    } catch {
      verdicts = [];
    }

    // ③ 懒刷新：**先读后刷**，本轮用旧值，新值给下一轮。fire-and-forget。
    try {
      deps.refresh();
    } catch {
      /* 静默：可见性绝不能拖垮 turn */
    }

    if (verdicts.length === 0 && state.recoveries.length === 0) return;

    // ③.5 恢复播报排空（额度恢复播报）：service 在 applySnapshot 的观测重置分支推入
    // 的事件。门槛 = 闩锁存在（本会话曾真播报过）——从未告警过的 provider 无「恢复」
    // 可言，事件静默丢弃（consume-once，不积压不重试）。必须在下方 L0 删闩锁**之前**
    // 判定：重置后的 verdict 多为 L0，先删闩锁会把「曾播报」一并抹掉。
    const recoveryEvents: QuotaRecoveryEvent[] = [];
    for (const event of state.recoveries.splice(0)) {
      if (state.latches.has(event.provider)) recoveryEvents.push(event);
    }
    const recoveredProviders = new Set(recoveryEvents.map((e) => e.provider));
    // 可用播报（B 方案）本轮新观测到的「低于 L1」provider。
    const available: ProviderVerdict[] = [];

    const sections: { verdict: ProviderVerdict; alternatives: AlternativeSelection }[] = [];
    // 旧闩锁快照：minInterval 吞掉 / send 失败两条回滚路径共用（Minor 1/2）。
    const latchesBefore = new Map<string, QuotaAnnounceLatch | undefined>();
    for (const v of verdicts) {
      if (v.level === 0) {
        // reset-elapsed 窗口把等级归零的 L0 不是真实读数（快照还没刷新）：不删闩锁。
        // 此处删掉会把即将到来的恢复事件（service 观测重置后推入 recoveries）的门槛
        // （「本会话曾真播报过」）抹掉，恢复播报被静默吞掉（漏报）；真实读数落地后
        // 由恢复路径或下一轮的 L0 分支正常清闸。
        if (v.windows.some((w) => w.reason === "reset-elapsed")) continue;
        const latch = state.latches.get(v.provider);
        // 滞回（2026-10-23 拍板）：等级回到 0 若只是预测消失（windows 无 forecast-*
        // reason、且 pct 相对闩锁回落 < QUOTA_HYSTERESIS_PCT），不清闩锁、也不触发
        // 「订阅可用」——38%→39%(L0)→40%(L2) 不重报；本栈已报过预警/提示的 provider
        // 在真实重置（reset-elapsed 已在上面 continue / pct 回落 ≥ 滞回阈值 / 恢复
        // 事件）前不再报「可用」。恢复事件是 service 认定的观测重置，优先于滞回。
        if (latch !== undefined && !recoveredProviders.has(v.provider) && isForecastDrop(v, latch)) continue;
        // 可用播报（B 方案）：本栈首次观测到窗口型 provider 真实读数低于 L1 ⇒
        // 一次性注入「订阅可用」。stale（M1：读数不真不进注入流）与 demoted
        // （刻意停放中，播「可用」会诱导派单打脸）都不播。去重键 = provider + 各窗口
        // resetAt 指纹（跨 /reload 持久化；窗口重置后允许再报一次）。
        const key = quotaAvailableKey(v.provider, v.windows);
        if (v.windows.length > 0 && !v.stale && !v.demoted && !state.availableAnnounced.has(key)) {
          state.availableAnnounced.add(key);
          available.push(v);
        }
        // 恢复 provider 的 L0 删闩锁要登记回滚：send 失败时恢复事件会回队重试，
        // 而重试的门槛（「曾播报」）就是这个闩锁——它不能随一次失败的发送消失。
        if (recoveredProviders.has(v.provider)) {
          latchesBefore.set(v.provider, latch);
        }
        state.latches.delete(v.provider);
        continue;
      }

      // M1（评审修订）：stale 快照不进注入流 —— 不闩锁、不复读，只进 HUD。
      if (v.stale) continue;

      const latch = state.latches.get(v.provider);
      const decision = shouldAnnounce(v, latch, {
        now: t,
        tickStepPercent: state.tickStepPercent,
        repeatMs: state.repeatMs,
        turn: state.turns,
        l1MinTurns: state.l1MinTurns,
      });
      if (recoveredProviders.has(v.provider)) {
        // 恢复块已携带该 provider 的当前读数与闸门状态：本轮不再注入常规块（「每个
        // provider 每次观测重置至多一条」）。但闩锁仍推进到当前状态——否则被跳过的
        // L3 复读 / 网格前进会在下一轮立刻补发，等于对同一次重置双播；推进也登记
        // 进 latchesBefore（send 失败时与恢复事件一起回滚重试）。
        latchesBefore.set(v.provider, latch);
        state.latches.set(v.provider, decision.next);
        continue;
      }
      if (!decision.announce) continue;
      // 3b 软化滞回（2026-10-23 拍板）：仍处 3b-only L2（软化「提示」级）且闩锁已
      // 在 ≥2 级时不重报——预测抖动（38%→39%(L0 保留闩锁)→40%）里跨网格步的前进
      // 也不再说话；只有真正升级（百分比阈值 L2 / 3a / L3）才会再注入。
      if (isForecastSoftVerdict(v) && latch !== undefined && latch.level >= 2) continue;
      latchesBefore.set(v.provider, latch);
      state.latches.set(v.provider, decision.next);
      let alternatives: AlternativeSelection = { providers: [], subscription: true };
      if (deps.alternatives !== undefined) {
        try {
          alternatives = deps.alternatives(v.provider);
        } catch {
          alternatives = { providers: [], subscription: true }; // 替代链算不出不致命——文案回落「无替代候选」句式。
        }
      }
      sections.push({ verdict: v, alternatives });
    }
    if (sections.length === 0 && recoveryEvents.length === 0 && available.length === 0) return;

    const rollbackLatches = (): void => {
      for (const [provider, before] of latchesBefore) {
        if (before === undefined)
          state.latches.delete(provider); // Minor 2：首次进入者用 delete
        else state.latches.set(provider, before);
      }
      // 可用播报回滚：本轮新播报的 provider 从已播集合移除（下一轮重试）。键与正路径同源（provider + resetAt 指纹）。
      for (const v of available) state.availableAnnounced.delete(quotaAvailableKey(v.provider, v.windows));
    };

    let maxLevel: LadderLevel = 0;
    for (const s of sections) {
      if (s.verdict.level > maxLevel) maxLevel = s.verdict.level;
    }

    // ④ 全局最小间隔（硬性防刷屏地板）；L3 与恢复播报绕过——两者都直接改变本轮
    //    派单决策（L3 = 立即避开，恢复 = 可以回去用），且恢复事件 consume-once +
    //    窗口重置天然数小时间隔，无刷屏面。发送后照常推进 lastSentAt（后续常规
    //    tick 仍受地板约束，与 L3 路径一致）。
    if (
      maxLevel < 3 &&
      recoveryEvents.length === 0 &&
      available.length === 0 &&
      state.lastSentAt > 0 &&
      t - state.lastSentAt < state.minIntervalMs
    ) {
      // 撤回本轮闩锁推进——「被间隔吞掉的那一步」不能永远不再播报。
      rollbackLatches();
      return;
    }

    // ⑤ 一轮一条合并消息（恢复块在前——它改变派单决策，比走势 tick 更重要；
    //    可用播报次之——它同样直接改变派单路由）。
    const parts: string[] = buildQuotaRecoveryTexts(recoveryEvents, t);
    parts.push(...buildQuotaAvailableTexts(available));
    const body = sections.length > 0 ? buildQuotaMessage(sections, t) : "";
    if (body !== "") parts.push(body);
    try {
      deps.sendMessage(
        {
          customType: QUOTA_CUSTOM_TYPE,
          content: parts.join("\n"),
          display: state.display,
          details: {
            level: maxLevel,
            ...(recoveryEvents.length > 0
              ? {
                  recoveries: recoveryEvents.map((e) => ({
                    provider: e.provider,
                    scopes: [...e.resetScopes],
                    level: e.verdict.level,
                    gateBlocked: e.gateBlocked,
                  })),
                }
              : {}),
            providers: sections.map((s) => ({
              provider: s.verdict.provider,
              level: s.verdict.level,
              demoted: s.verdict.demoted,
              windows: s.verdict.windows.map((w) => ({ scope: w.scope, usedPct: w.usedPct, level: w.level })),
            })),
            ...(available.length > 0 ? { available: available.map((v) => v.provider) } : {}),
          },
        },
        { triggerTurn: false },
      );
      state.lastSentAt = t;
      // 可用播报持久化（跨 /reload 去重）：本轮真播报过「订阅可用」才写全量键集；
      // 键集未变不重复写（条目越少，读回超headroom 越小）。
      if (available.length > 0 && deps.persistAvailable !== undefined) {
        const keys = [...state.availableAnnounced].sort();
        const serialized = keys.join("\n");
        if (serialized !== lastPersistedKeys) {
          lastPersistedKeys = serialized;
          try {
            deps.persistAvailable(keys);
          } catch {
            /* 持久化失败不致命：本栈内仍去重，下一轮重报时再试 */
          }
        }
      }
    } catch (error) {
      // Minor 1（评审）同哲学：send 失败 ⇒ 闩锁回滚 + 恢复事件回队（下一轮重试；
      // 「至多一条」仍成立——它尚未真正送达）。
      rollbackLatches();
      state.recoveries.unshift(...recoveryEvents);
      console.warn(`[pi-subagent] quota hint send failed: ${String(error)}`);
    }
  };
}
