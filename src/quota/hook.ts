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
 * - 三闸 shouldAnnounce（D4）：等级抬升 / usedPct 网格前进 / L2+ 复读；
 *   L0 清闩锁。每轮**至多一条**合并消息（所有 provider 拼一个块）。
 * - 闩锁回滚（Minor 1/2）：被 `minIntervalMs` 吞掉的一步、以及 send 失败的
 *   一轮，都把闩锁滚回本轮前的值（首次进入者用 `delete` 而非 set 脏值）——
 *   「被吞掉的那一次网格前进」永远不会再播报是 bug。
 * - L3 绕过全局最小间隔（它直接改变本轮派单决策）。
 * - `sendMessage` / `verdicts` / `refresh` 抛被 catch：turn_end 不可拖垮。
 * - print/json 模式直接 return（子会话惰性，R12——钩子本身只在主会话注册，
 *   此门是双保险）。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Millis } from "../core/types.js";
import { gridStep, QUOTA_HYSTERESIS_PCT, type ProviderVerdict } from "./ladder.js";
import { buildQuotaMessage } from "./render.js";
import type { LadderLevel } from "./types.js";

export const QUOTA_CUSTOM_TYPE = "subagent:quota";

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
   * （偏差记录）§5.1 伪码引用了 `pickAlternativesFor(v)` 但 §3.10 的 deps
   * 没有提供数据面——补这个**可选**注入：provider → 替代模型 `provider/id`
   * 列表（Pack A 接线时用 gate.ts 的 `pickAlternatives` 供给）。缺省 `[]`，
   * render 层回落到「无更优替代模型」句式。可选字段与 §4.2 的接线代码
   * （只传 state/verdicts/refresh/sendMessage）保持兼容。
   */
  readonly alternatives?: ((provider: string) => readonly string[]) | undefined;
}

/**
 * 防噪音判定（§5.4，纯函数，单测直打不经钩子）：
 * 闸① 等级抬升；闸② 网格前进；闸③ L2+ 复读。重新武装：等级下降且百分比
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
  if (verdict.level >= 2 && input.now - latch.at >= input.repeatMs) return { announce: true, next }; // 闸③ L2+ 复读
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

    if (verdicts.length === 0) return;

    const sections: { verdict: ProviderVerdict; alternatives: readonly string[] }[] = [];
    // 旧闩锁快照：minInterval 吞掉 / send 失败两条回滚路径共用（Minor 1/2）。
    const latchesBefore = new Map<string, QuotaAnnounceLatch | undefined>();
    for (const v of verdicts) {
      if (v.level === 0) {
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
      if (!decision.announce) continue;
      latchesBefore.set(v.provider, latch);
      state.latches.set(v.provider, decision.next);
      let alternatives: readonly string[] = [];
      if (deps.alternatives !== undefined) {
        try {
          alternatives = deps.alternatives(v.provider);
        } catch {
          alternatives = []; // 替代链算不出不致命——文案回落「无更优替代」句式。
        }
      }
      sections.push({ verdict: v, alternatives });
    }
    if (sections.length === 0) return;

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

    // ④ 全局最小间隔（硬性防刷屏地板）；L3 绕过（它直接改变本轮派单决策）。
    if (maxLevel < 3 && state.lastSentAt > 0 && t - state.lastSentAt < state.minIntervalMs) {
      // 撤回本轮闩锁推进——「被间隔吞掉的那一步」不能永远不再播报。
      rollbackLatches();
      return;
    }

    // ⑤ 一轮一条合并消息。
    try {
      deps.sendMessage(
        {
          customType: QUOTA_CUSTOM_TYPE,
          content: buildQuotaMessage(sections, t),
          display: state.display,
          details: {
            level: maxLevel,
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
      // Minor 1（评审）：send 失败同样回滚闩锁——与 minInterval 路径同哲学。
      rollbackLatches();
      console.warn(`[pi-subagent] quota hint send failed: ${String(error)}`);
    }
  };
}
