import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  COMPACT_HINT_COOLDOWN_MS,
  COMPACT_HINT_CUSTOM_TYPE,
  USAGE_TICK_CUSTOM_TYPE,
  USAGE_TICK_HYSTERESIS_PERCENT,
  buildCompactForceText,
  buildCompactHintText,
  buildSwitchDemandText,
  buildSwitchHintText,
  buildUsageTickText,
  effectiveThresholdPercentWithTokens,
  usageTickStep,
  windowScaledForcePercent,
} from "./threshold.js";
import { HYSTERESIS_PCT, resolveEffectiveHint } from "./dynamic/threshold.js";
import { hintNote, tickMarker } from "./dynamic/markers.js";
import { type DynamicRuntime } from "./dynamic/wire.js";
import type { DynamicThresholdOutcome, ThresholdBasis } from "./dynamic/types.js";
import { RESUME_TEXT } from "./compact-tool.js";

export interface CompactHintState {
  thresholdPercent: number;
  /** Force line anchor. With `forceScaling` on this is the value for a 1M
   *  window and is scaled per decade against the real one; otherwise literal. */
  forceAtPercent: number;
  /** Scale `forceAtPercent` with the context window (default on). */
  forceScaling: boolean;
  /** Absolute thresholds in units of k tokens (0 = off); combined with the
   *  percent lines via min — whichever fires first wins. */
  thresholdTokens: number;
  forceAtTokens: number;
  reserveTokens: number;
  lastHintAt: number;
  /** hint 已发过的闩锁。`hintEpoch` 仅在 mode="on"（动态阈值，§9.2）时携带：高位期编号，
   *  真实用量跌破 line − 迟滞时由 runtime 自增并清空本字段（线自己动不重置提醒权）。 */
  hintedAt: { effectivePercent: number; contextWindow: number; hintEpoch?: number } | undefined;
  /** Coarsest step (percent points) between lightweight usage-tick reports;
   *  the grid densifies toward the force ceiling. 0 disables ticks. */
  tickStepPercent: number;
  /** Highest tick step already reported (0 = none). Re-armed downward only by
   *  a real drop larger than USAGE_TICK_HYSTERESIS_PERCENT (e.g. compaction),
   *  so boundary wobble never re-notifies. */
  lastTickStep: number;
  /** switch_context 模式（settings.compact.switchTool）：hint/force 层改为催模型自写交接。 */
  switchTool: boolean;
  /** 越线后先硬性要求切换的次数上限；用完仍越线才回落通用强制压缩。 */
  forceDemandTurns: number;
  /** 本轮高位期内已发出的硬性切换要求次数；用量回落到强制线以下即归零。 */
  demandCount: number;
  /** 价格感知动态阈值运行时（dynamic-threshold-plan.md D3）；mode=off / print、json 构造
   *  时缺席或惰性。与 `Stack.dynamic` 引用同一对象（§2.4 所有权在 Stack）。 */
  dynamic?: DynamicRuntime | undefined;
  /** child-context-switch plan §2.2/§4：本 run 切换次数已达 `compact.childMaxSwitches` 上限。
   *  只在子会话 headless 构造时设定（P3）；为 true 时只保留 tick，不再发 hint/demand（不能
   *  让模型去做做不了的事）。主会话不设置 ⇒ 行为逐字节不变。 */
  switchesExhausted?: () => boolean;
}

/** Narrow view of the stack holder: the hook only reads `current.compactHint`. */
export interface CompactHintHolder {
  current?: { compactHint: CompactHintState };
}

/** Build the per-session L2/L3 stack (extracted from index.ts to keep it
 *  assembly-only, D7). Rebuilt on every session_start: ctx.sessionManager is
 *  only available there. */
/**
 * Production `message_start` → context-receipt hook. Lives here instead of
 * inline in index.ts so integration tests exercise the real filter +
 * forwarding path (customType literal, event shape) — index.ts stays
 * assembly-only (I7) and just registers this once per activate().
 */
export function createCompactHintHook(
  holder: CompactHintHolder,
  deps: {
    sendMessage: (
      // Visible by default (like subagent notifications): the user sees the
      // same message the model receives, persisted in the transcript.
      message: { customType: string; content: string; display: boolean; details: unknown },
      options: { triggerTurn: false },
    ) => void;
    now?: () => number;
    sendUserMessage?: (text: string) => void;
    /** switch_context 已暂存交接文本、压缩尚未完成 —— 此时既不再催，也不抢先强制压缩。 */
    handoffPending?: () => boolean;
    /** child-context-switch plan §2.2：子会话无头版——跳过 print/json 早退，绝不 ctx.compact()。 */
    headless?: boolean;
    /** 替代 holder.current?.compactHint：子会话不需要伪造一整个 Stack（plan §2.2）。 */
    getState?: () => CompactHintState | undefined;
  },
): (event: unknown, ctx: ExtensionContext) => void {
  const now = deps.now ?? (() => Date.now());
  let forcing = false;
  let lastForcedAt = 0;
  // §9.2「真实用量跌破」的方向坐标：上一轮观测到的 percent（unknown-usage 归零）。
  // 动态线上移越过静止/上潳的用量时不是「真实回落」，不得重置提醒权（设计意图：
  // 只有真实用量的回落才重置，任何「线自己动了」都不重置）。
  let lastPercentSeen: number | null = null;
  return (_event, ctx) => {
    if (!deps.headless && (ctx.mode === "print" || ctx.mode === "json")) return;
    const state = deps.getState ? deps.getState() : holder.current?.compactHint;
    if (
      !state ||
      (state.thresholdPercent <= 0 &&
        state.forceAtPercent <= 0 &&
        state.thresholdTokens <= 0 &&
        state.forceAtTokens <= 0 &&
        state.tickStepPercent <= 0)
    )
      return;
    const usage = ctx.getContextUsage();
    const percent = usage?.percent;
    const debug = process.env.PI_SUBAGENT_DEBUG_COMPACT_HINT === "1";
    if (debug)
      console.warn(
        `[pi-subagent] compact-hint usage=${JSON.stringify(usage)} hintedAt=${JSON.stringify(state.hintedAt)}`,
      );
    if (!usage || percent == null) {
      state.hintedAt = undefined;
      lastPercentSeen = null;
      return;
    }
    const previousPercent = lastPercentSeen;
    lastPercentSeen = percent;
    // ── 动态阈值（dynamic-threshold-plan.md §3.6/§9.2/§10）：每轮 turn_end 重算一次（S1）。
    // 无 runtime（mode=off / compact 关）/ 惰性 / 内部禁用 ⇒ 合成与闩锁走原表达式
    //（mode=off 逐字节回滚保证，T-D3-OFF-GOLDEN）；shadow 只计算 + 遥测，不改模型可见字节。
    const activeRuntime = state.dynamic;
    let dyn: DynamicThresholdOutcome | undefined;
    if (activeRuntime !== undefined && activeRuntime.active) {
      try {
        dyn = activeRuntime.onTurnEnd({
          ctx, // 完整事件 ctx：mode（二次判惰性）+ sessionManager（§5.5 观察窗聚合）
          model: ctx.model,
          usage: { tokens: usage.tokens ?? null, percent, contextWindow: usage.contextWindow },
          staticHint: { percent: state.thresholdPercent, tokensK: state.thresholdTokens },
          force: {
            atPercent: state.forceAtPercent,
            atTokensK: state.forceAtTokens,
            forceScaling: state.forceScaling,
          },
          reserveTokens: state.reserveTokens,
        });
      } catch {
        dyn = undefined; // wire 内部已有 try/catch；这里再次兑底：遥测/动态层绝不拖垮主链路
      }
    }
    const runtimeOn =
      activeRuntime !== undefined && activeRuntime.active && activeRuntime.mode === "on" ? activeRuntime : undefined;
    const usableDyn = runtimeOn !== undefined && dyn?.usable === true ? dyn : undefined;
    // §3.6 合成（D3：min —— 动态线只能提前）。静态线更早 / 退化 / shadow / off ⇒ 原表达式不动。
    // 与 /agent status 共用 resolveEffectiveHint，保证 status 显示的生效线与真实触发点一致。
    const resolvedHint = resolveEffectiveHint({
      staticEffectivePercent: effectiveThresholdPercentWithTokens(
        state.thresholdPercent,
        state.thresholdTokens,
        usage.contextWindow,
        state.reserveTokens,
      ),
      staticLines: { percent: state.thresholdPercent, tokensK: state.thresholdTokens },
      window: usage.contextWindow,
      reserveTokens: state.reserveTokens,
      dynamic: usableDyn,
    });
    const effective = resolvedHint.percent;
    const dynamicLineWon = resolvedHint.dynamicWon;
    const effectiveForce = effectiveThresholdPercentWithTokens(
      state.forceScaling ? windowScaledForcePercent(state.forceAtPercent, usage.contextWindow) : state.forceAtPercent,
      state.forceAtTokens,
      usage.contextWindow,
      state.reserveTokens,
    );
    // child-context-switch plan §2.2：切换次数已用尽 ⇒ 不再进入 force 分支（不发 hint/demand），
    // 落到下面的 tick-only 早退（不能让模型去做做不了的事；兜底交给 pi 自己的自动压缩）。
    const switchesExhausted = state.switchesExhausted?.() === true;
    if (!switchesExhausted && effectiveForce > 0 && percent >= effectiveForce) {
      const timestamp = now();
      // switch_context 模式（先礼后兵）：越线先硬性要求模型自己写交接内容，
      // 只有它不照办（下一次 turn_end 仍越线）才回落到通用强制压缩——安全网不能拆。
      if (state.switchTool) {
        if (deps.handoffPending?.()) {
          if (debug) console.warn("[pi-subagent] compact-hint force skipped: handoff pending");
          return;
        }
        if (state.demandCount < state.forceDemandTurns) {
          state.demandCount += 1;
          if (debug)
            console.warn(
              `[pi-subagent] switch-context demand percent=${percent} force=${effectiveForce} attempt=${state.demandCount}`,
            );
          if (ctx.hasUI) {
            try {
              ctx.ui.notify(
                `Context ${Math.round(percent)}% ≥ ${effectiveForce}% — demanding switch_context`,
                "warning",
              );
            } catch {}
          }
          try {
            deps.sendMessage(
              {
                customType: COMPACT_HINT_CUSTOM_TYPE,
                content: buildSwitchDemandText(percent, effectiveForce),
                display: true,
                details: { percent, thresholdPercent: effectiveForce, demand: true, attempt: state.demandCount },
              },
              { triggerTurn: false },
            );
            // §5.4：demand 发出 ⇒ 建立 forceMarker（发送失败则不建，不留脏归因）。
            activeRuntime?.noteForce("demand");
          } catch (error) {
            console.warn(`[pi-subagent] switch-context demand send failed: ${String(error)}`);
          }
          return;
        }
        if (deps.headless) {
          // 子会话没有扩展侧强制压缩通道（ctx.compact() 会 abort 结束 run）：demand 用尽后交给
          // pi 自身的自动压缩兜底（用户确认 3 选 A），绝不在这里调用 ctx.compact()。
          if (debug) console.warn("[pi-subagent] compact-hint headless: demand exhausted, no forced compaction");
          return;
        }
      }
      if (forcing || (lastForcedAt > 0 && timestamp - lastForcedAt < COMPACT_HINT_COOLDOWN_MS)) {
        if (debug) console.warn(`[pi-subagent] compact-hint force skipped: ${forcing ? "in-flight" : "cooldown"}`);
        return;
      }
      forcing = true;
      lastForcedAt = timestamp;
      state.demandCount = 0;
      if (debug)
        console.warn(`[pi-subagent] compact-hint force triggered percent=${percent} effective=${effectiveForce}`);
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(`Context ${Math.round(percent)}% ≥ ${effectiveForce}% — forcing compaction`, "warning");
        } catch {}
      }
      try {
        deps.sendMessage(
          {
            customType: COMPACT_HINT_CUSTOM_TYPE,
            content: buildCompactForceText(percent, effectiveForce),
            display: true,
            details: { percent, thresholdPercent: effectiveForce, forced: true },
          },
          { triggerTurn: false },
        );
        // §5.4：force 压缩已发起 ⇒ 建立 forceMarker；成败由 session_compact / onError /
        // 同步 catch / session_compact_failed 四条路径归宿（R2-4）。
        activeRuntime?.noteForce("force");
      } catch (error) {
        console.warn(`[pi-subagent] compact-hint force notice send failed: ${String(error)}`);
      }
      try {
        ctx.compact({
          onComplete: () => {
            forcing = false;
            try {
              deps.sendUserMessage?.(RESUME_TEXT);
            } catch {}
          },
          onError: (error) => {
            forcing = false;
            activeRuntime?.clearForceMarker(); // §5.4 清除②：ctx.compact() 失败立即清
            if (debug) console.warn(`[pi-subagent] compact-hint force failed: ${error.message}`);
          },
        });
      } catch (error) {
        forcing = false;
        activeRuntime?.clearForceMarker(); // §5.4 清除②：同步抛出同样立即清
        if (debug) console.warn(`[pi-subagent] compact-hint force failed synchronously: ${String(error)}`);
      }
      return;
    }
    // Usage ticks: lightweight stepped reports at every step so the model
    // stays aware of context usage across the whole range — including the L1
    // hint zone (the hint fires only once, ticks keep the visibility alive);
    // the force zone (L2) owns the range at/above its ceiling. The grid is
    // non-linear: it densifies as usage approaches the ceiling, so reminders
    // get more frequent exactly where acting on them matters. Latched per
    // step; re-armed only by a real drop larger than the hysteresis (e.g.
    // compaction), never by boundary wobble.
    const tickCeiling = effectiveForce > 0 ? effectiveForce : 100;
    // 回到强制线以下：硬性切换要求的计数归零（下次越线重新先礼后兵）。
    state.demandCount = 0;
    const tick = usageTickStep(percent, state.tickStepPercent, tickCeiling);
    if (tick < state.lastTickStep && percent <= state.lastTickStep - USAGE_TICK_HYSTERESIS_PERCENT) {
      state.lastTickStep = tick;
    }
    // §10.1：tick 尾部的英文短标记（仅 mode=on 且有 hint 线；省略 ⇒ 文案与今天逐字节相同）。
    const tickMarkerText =
      runtimeOn !== undefined && effective > 0
        ? tickMarker(
            dynamicLineWon && usableDyn !== undefined ? usableDyn.basis : "static",
            effective,
            usableDyn?.nextTierTokens,
          )
        : undefined;
    const trySendTick = () => {
      if (tick <= state.lastTickStep) return;
      try {
        deps.sendMessage(
          {
            customType: USAGE_TICK_CUSTOM_TYPE,
            content: buildUsageTickText(
              percent,
              effective > 0 ? effective : 0,
              state.switchTool ? "switch_context" : "compact_context",
              tickMarkerText,
            ),
            display: true,
            details: { percent, tickStep: tick },
          },
          { triggerTurn: false },
        );
        state.lastTickStep = tick;
        if (debug) console.warn(`[pi-subagent] usage-tick sent percent=${percent} step=${tick} ceiling=${tickCeiling}`);
      } catch (error) {
        console.warn(`[pi-subagent] usage-tick send failed: ${String(error)}`);
      }
    };
    // §9.2 闩锁：mode=on ⇒ epoch 闩锁（线自己动不重置提醒权；只有真实用量跌破
    // line − 迟滞才重置）；其余模式 ⇒ 与今天逐字节等价的表达式。
    if (effective <= 0 || percent < effective) {
      if (runtimeOn !== undefined) {
        // 真实回落（跌破 line − 迟滞 **且用量确实在下降**）才重置提醒权；
        // 动态线上移越过静止的用量不算（「线自己动了」不重置，§9.2 设计意图）。
        if (
          effective > 0 &&
          percent < effective - HYSTERESIS_PCT &&
          previousPercent !== null &&
          percent < previousPercent
        ) {
          runtimeOn.noteRealDrop();
          state.hintedAt = undefined;
        }
      } else {
        state.hintedAt = undefined;
      }
      trySendTick();
      return;
    }
    if (switchesExhausted) {
      // 上面的 force 分支已被旁路；这里拦下普通 hint（percent 仍在 [effective, effectiveForce) 区间时），
      // 只留 tick，同样不再提议模型去做做不了的事。
      trySendTick();
      return;
    }
    const latched =
      runtimeOn !== undefined
        ? state.hintedAt?.hintEpoch !== undefined && state.hintedAt.hintEpoch === runtimeOn.hintEpoch()
        : state.hintedAt?.effectivePercent === effective && state.hintedAt.contextWindow === usage.contextWindow;
    // §6.3 跨档前一次性提醒：允许突破 hint 的冷却发一次（每个 B 一张票；P1-9：B 本身仍属低价档）。
    const tierTicket =
      runtimeOn !== undefined && usableDyn !== undefined && runtimeOn.consumeTierTicket(usage.tokens ?? null);
    if (latched && !tierTicket) {
      trySendTick();
      return;
    }
    const timestamp = now();
    if (!tierTicket && state.lastHintAt > 0 && timestamp - state.lastHintAt < COMPACT_HINT_COOLDOWN_MS) {
      trySendTick();
      return;
    }
    // §10.2：动态线的中文单行说明。仅当动态线真正生效（dynamicLineWon）或跨档票
    // 命中时附加——静态线独占时阈值并非价格模型给出，不能冒充；demand（L2）不加。
    let note: string | undefined;
    if (usableDyn !== undefined && (dynamicLineWon || tierTicket)) {
      const noteBasis: ThresholdBasis = tierTicket ? "tier" : usableDyn.basis;
      note = hintNote(noteBasis, {
        hintPercent: effective,
        usedTokens: usage.tokens ?? null,
        window: usage.contextWindow,
        nextTierTokens: usableDyn.nextTierTokens,
        ...(usableDyn.subscriptionPressure !== undefined ? { usedPct: usableDyn.subscriptionPressure } : {}),
      });
    }
    try {
      deps.sendMessage(
        {
          customType: COMPACT_HINT_CUSTOM_TYPE,
          content: state.switchTool
            ? buildSwitchHintText(percent, effective, effectiveForce, note)
            : buildCompactHintText(percent, effective, effectiveForce, note),
          display: true,
          details: { percent, thresholdPercent: effective },
        },
        { triggerTurn: false },
      );
    } catch (error) {
      console.warn(`[pi-subagent] compact-hint send failed: ${String(error)}`);
      return;
    }
    state.hintedAt =
      runtimeOn !== undefined
        ? { effectivePercent: effective, contextWindow: usage.contextWindow, hintEpoch: runtimeOn.hintEpoch() }
        : { effectivePercent: effective, contextWindow: usage.contextWindow };
    state.lastHintAt = timestamp;
    // The hint already reports the current percent — absorb any pending tick
    // step so we don't double-inject usage info in the same turn.
    if (tick > state.lastTickStep) state.lastTickStep = tick;
    if (debug)
      console.warn(
        `[pi-subagent] compact-hint sent percent=${percent} effective=${effective} contextWindow=${usage.contextWindow}`,
      );
    if (ctx.hasUI) {
      try {
        ctx.ui.notify(`Context ${Math.round(percent)}% ≥ ${effective}% — hinted model to compact`, "info");
      } catch {
        // UI notification is best effort.
      }
    }
  };
}
