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
 * - `sendMessage` / `verdicts` / `refresh` 抛被 catch：turn_end 不可拖垮。
 * - print/json 模式直接 return（子会话惰性，R12——钩子本身只在主会话注册，
 *   此门是双保险）。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Millis } from "../core/types.js";
import { gridStep, QUOTA_HYSTERESIS_PCT, type ProviderVerdict, type QuotaRecoveryEvent } from "./ladder.js";
import { buildQuotaMessage, buildQuotaRecoveryText, type AlternativeSelection } from "./render.js";
import type { LadderLevel } from "./types.js";

export const QUOTA_CUSTOM_TYPE = "subagent:quota";

/** 恢复收件箱容量上限（createQuotaStack 推入时截断丢最旧）——只是防积压保险：
 * 正常节奏下每窗口每 provider 数小时至多一条；钩子关闭/ print 模式下无人排空也不膨胀。 */
export const QUOTA_RECOVERY_INBOX_CAP = 16;

export interface QuotaAnnounceLatch {
  level: LadderLevel;
  step: number;
  at: Millis;
  usedPct: number;
}

/** 会话级可变状态，挂在 Stack 上（每次 session_start 重建；无模块级状态）。 */
export interface QuotaHintState {
  readonly enabled: boolean;
  readonly tickStepPercent: number;
  readonly repeatMs: Millis;
  readonly minIntervalMs: Millis;
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
  input: { readonly now: Millis; readonly tickStepPercent: number; readonly repeatMs: Millis },
): { readonly announce: boolean; readonly next: QuotaAnnounceLatch } {
  // provider 的代表百分比：全部窗口取最高（余额型无窗口 ⇒ 0）。
  let pct = 0;
  for (const w of verdict.windows) {
    if (w.usedPct > pct) pct = w.usedPct;
  }
  const step = gridStep(pct, input.tickStepPercent);
  const next: QuotaAnnounceLatch = { level: verdict.level, step, at: input.now, usedPct: pct };

  if (latch === undefined) return { announce: true, next }; // 首次进入 L>=1

  // 重新武装：等级下降 + 百分比真实回落 ⇒ 窗口重置，闩锁作废。
  if (verdict.level < latch.level && pct <= latch.usedPct - QUOTA_HYSTERESIS_PCT) {
    return { announce: verdict.level >= 1, next };
  }

  if (verdict.level > latch.level) return { announce: true, next }; // 闸① 等级抬升
  if (step > latch.step) return { announce: true, next }; // 闸② 网格前进
  // 闸③ 复读只给 L3：L2 是纯提示（订阅优先用完），复读只会刷屏。
  if (verdict.level >= 3 && input.now - latch.at >= input.repeatMs) return { announce: true, next };
  return { announce: false, next: latch };
}

export function createQuotaHintHook(deps: QuotaHintDeps): (event: unknown, ctx: ExtensionContext) => void {
  const now = deps.now ?? (() => Date.now());
  return (_event: unknown, ctx: ExtensionContext): void => {
    // ① 模式门：子会话是 print 模式，派单信息对它毫无意义（与 compact-hint 逐字同款）。
    if (ctx.mode === "print" || ctx.mode === "json") return;
    const state = deps.state();
    if (state === undefined || !state.enabled) return;

    const t = now();

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

    const sections: { verdict: ProviderVerdict; alternatives: AlternativeSelection }[] = [];
    // 旧闩锁快照：minInterval 吞掉 / send 失败两条回滚路径共用（Minor 1/2）。
    const latchesBefore = new Map<string, QuotaAnnounceLatch | undefined>();
    for (const v of verdicts) {
      if (v.level === 0) {
        // 恢复 provider 的 L0 删闩锁要登记回滚：send 失败时恢复事件会回队重试，
        // 而重试的门槛（「曾播报」）就是这个闩锁——它不能随一次失败的发送消失。
        if (recoveredProviders.has(v.provider)) {
          latchesBefore.set(v.provider, state.latches.get(v.provider));
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
    if (sections.length === 0 && recoveryEvents.length === 0) return;

    const rollbackLatches = (): void => {
      for (const [provider, before] of latchesBefore) {
        if (before === undefined)
          state.latches.delete(provider); // Minor 2：首次进入者用 delete
        else state.latches.set(provider, before);
      }
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
      state.lastSentAt > 0 &&
      t - state.lastSentAt < state.minIntervalMs
    ) {
      // 撤回本轮闩锁推进——「被间隔吞掉的那一步」不能永远不再播报。
      rollbackLatches();
      return;
    }

    // ⑤ 一轮一条合并消息（恢复块在前——它改变派单决策，比走势 tick 更重要）。
    const parts: string[] = recoveryEvents.map((event) => buildQuotaRecoveryText(event, t));
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
          },
        },
        { triggerTurn: false },
      );
      state.lastSentAt = t;
    } catch (error) {
      // Minor 1（评审）同哲学：send 失败 ⇒ 闩锁回滚 + 恢复事件回队（下一轮重试；
      // 「至多一条」仍成立——它尚未真正送达）。
      rollbackLatches();
      state.recoveries.unshift(...recoveryEvents);
      console.warn(`[pi-subagent] quota hint send failed: ${String(error)}`);
    }
  };
}
