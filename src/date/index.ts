/**
 * [date] 注入 — pi-facing 装配（date 模块）。
 *
 * 规则（用户拍板）：
 * 1. 新会话/恢复会话后的**第一轮**注入一次当前日期+时刻（恢复后首轮同样注入，
 *    即使与 branch 里最后一条同日）；
 * 2. 之后**仅在跨日时**再注入：turn_end 检查（模型连续运行跨过午夜 ⇒ 下一次
 *    模型请求前注入，不等下一条用户消息）与 before_agent_start 检查（新一轮
 *    开始时已跨日）共用同一去重状态，同一日期至多注入一次；
 * 3. 闲置重注入：before_agent_start 时同日但距上次注入 ≥1h（墙钟，
 *    core 的 `DATE_REINJECT_IDLE_MS`，无新设置）⇒ 再注入一次当前日期+时刻
 *    （kind `"idle"`，裸标记）。turn_end **不做**闲置注入（运行中的 agent
 *    循环里不加）。上次注入时刻未知（旧条目缺 `details.at`）⇒ 不触发（规则 1
 *    的首轮注入本来就覆盖了恢复场景）；
 * 4. 内容见 `core.ts`（`[date] YYYY-MM-DD Ddd HH:MM (TZ)`，跨日附极短说明 +
 *    时刻语义；每条注入的 `details.at` 记录注入时刻 ms，供恢复播种读回）。
 *
 * 通道：
 * - 首轮/新一轮已跨日 ⇒ `before_agent_start` 返回 `message`。pi 的
 *   `emitBeforeAgentStart` 把**所有** handler 的 message 收进同一数组
 *   （dist/core/extensions/runner.js 的 `messages.push(result.message)`），
 *   与 sysprompt hub（src/sysprompt/hub.ts，仅在有 section 更新时才返回
 *   message）天然共存，互不吞消息。
 * - 运行中跨日 ⇒ `turn_end` 里 `sendMessage(..., { triggerTurn: false })`
 *   （照抄 src/quota/hook.ts / src/sysload/hook.ts 的隐藏消息通道：只进
 *   上下文、不额外起一轮模型调用）。
 *
 * 恢复播种：`session_start` 时读 `getBranch()`（绝不 `getEntries()`，可能读出
 * 陈旧 fork 分支）里最后一条 `subagent:date` custom_message 的 `details.date` +
 * `details.at` 作为跨日/闲置基线（旧条目缺 `at` ⇒ 时刻未知，仅日期可用）；
 * 子会话收不到 `session_start`（见 src/child/wire.ts 的事实注记），故
 * before_agent_start/turn_end 首次触发时也会懒播种一次。
 *
 * 主会话 + 子 agent 会话都注入（pre-guard 注册，参照 web_search/todo/memory），
 * 因此**没有** print/json 模式门。所有可变状态都在 wireDate 闭包内（每次
 * activate() 重建，无模块级状态）；无计时器，纯事件驱动。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createDateTimeSource,
  crossDayContent,
  DATE_CUSTOM_TYPE,
  dateChanged,
  firstTurnContent,
  idleReinjectDue,
  type DateTimeSource,
} from "./core.js";

export interface DateWireOpts {
  /** `date.enabled`；false ⇒ 零注册零行为（调用方也可直接不调用）。 */
  readonly enabled: boolean;
  /** 可注入时钟（测试用）。 */
  readonly now?: (() => number) | undefined;
  /** 可注入 IANA 时区（测试用）。 */
  readonly timeZone?: string | undefined;
}

/** branch 条目的最小读取面（`custom_message`：sendMessage/注入消息的落盘形状）。 */
export interface BranchEntryLike {
  type?: unknown;
  customType?: unknown;
  details?: unknown;
}

/** branch 里最后一次注入的回读形状（缺 date / 缺 `at` 都算未知，旧条目兼容）。 */
export interface LastInjection {
  readonly date?: string | undefined;
  readonly at?: number | undefined;
}

/**
 * 从 branch（新→旧扫描）读最后一条 `subagent:date` 的日期键 + 注入时刻。
 * 找不到/形状不对 ⇒ 空对象（新会话，或旧版本注入的条目缺 details）。纯函数，
 * 导出供测试。
 */
export function readLastInjection(branch: readonly BranchEntryLike[]): LastInjection {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type === "custom_message" && entry.customType === DATE_CUSTOM_TYPE) {
      const details = entry.details as { date?: unknown; at?: unknown } | undefined;
      const date = typeof details?.date === "string" && details.date !== "" ? details.date : undefined;
      const at = typeof details?.at === "number" && Number.isFinite(details.at) ? details.at : undefined;
      return { date, at };
    }
  }
  return {};
}

/** 旧行为兼容：只取日期键（委托 `readLastInjection`，单次扫描）。 */
export function readLastInjectedDate(branch: readonly BranchEntryLike[]): string | undefined {
  return readLastInjection(branch).date;
}

export function wireDate(pi: ExtensionAPI, opts: DateWireOpts): void {
  if (!opts.enabled) return; // date.enabled=false ⇒ 零注册零行为
  const source: DateTimeSource = createDateTimeSource({ timeZone: opts.timeZone });
  const now = opts.now ?? (() => Date.now());
  // 去重状态（activate() 闭包内）：首轮是否仍待注入 + 最后注入的日期键/时刻。
  let firstTurnPending = true;
  let seeded = false;
  let lastInjected: string | undefined;
  let lastInjectedAt: number | undefined;

  const seedFromBranch = (ctx: ExtensionContext): void => {
    if (seeded) return;
    seeded = true;
    try {
      const branch = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
      const last = readLastInjection(branch as readonly BranchEntryLike[]);
      lastInjected = last.date;
      lastInjectedAt = last.at;
    } catch {
      /* 裸宿主/异常上下文：空播种降级（repo 惯例：缺失 host API 静默降级） */
    }
  };

  // 同一 activate() 内的会话替换（/new、/resume、/fork）也会触发 session_start：
  // 重置首轮规则并按新 branch 重新播种。
  pi.on("session_start", (_event, ctx) => {
    firstTurnPending = true;
    seeded = false;
    lastInjected = undefined;
    lastInjectedAt = undefined;
    seedFromBranch(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    // 子会话收不到 session_start：首次触发时懒播种。
    seedFromBranch(ctx);
    const at = now();
    const key = source.dateKey(at);
    const crossDay = dateChanged(lastInjected, key);
    // 闲置重注入：同日、非首轮、上次注入时刻已知且距今 ≥1h（时钟回拨 ⇒ 负差值 ⇒ 不触发）。
    const idleDue = !firstTurnPending && !crossDay && idleReinjectDue(lastInjectedAt, at);
    // 首轮规则：firstTurnPending 时无条件注入（恢复后同日也注入一次）；之后仅
    // 跨日或闲置 ≥1h 注入，其余同日不注入。
    if (!firstTurnPending && !crossDay && !idleDue) return undefined;
    firstTurnPending = false;
    lastInjected = key;
    lastInjectedAt = at;
    return {
      message: {
        customType: DATE_CUSTOM_TYPE,
        content: crossDay ? crossDayContent(source.marker(at)) : firstTurnContent(source.marker(at)),
        display: false,
        details: { date: key, kind: crossDay ? "cross-day" : idleDue ? "idle" : "first", at },
      },
    };
  });

  pi.on("turn_end", (_event, ctx) => {
    seedFromBranch(ctx);
    const at = now();
    const key = source.dateKey(at);
    // 无基线不算跨日（正常时序里 turn_end 前必有 before_agent_start 或播种）。
    // 闲置重注入只走 before_agent_start：运行中的 agent 循环里不加注入。
    if (!dateChanged(lastInjected, key)) return;
    const previous = lastInjected;
    const previousAt = lastInjectedAt;
    lastInjected = key;
    lastInjectedAt = at;
    try {
      pi.sendMessage(
        {
          customType: DATE_CUSTOM_TYPE,
          content: crossDayContent(source.marker(at)),
          display: false,
          details: { date: key, kind: "cross-day", at },
        },
        { triggerTurn: false },
      );
    } catch (error) {
      // 发送失败 ⇒ 回滚基线（quota hook 闩锁回滚同哲学）：下一次 turn_end /
      // before_agent_start 按跨日重试，「同一日期只注入一次」针对真正送达的消息。
      lastInjected = previous;
      lastInjectedAt = previousAt;
      console.warn(`[pi-subagent] date inject send failed: ${String(error)}`);
    }
  });
}
