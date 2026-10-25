/**
 * traffic → pi 原生 cache warming 否决钩子（traffic-merge plan §7.3，T5；方案作者 consult 裁定）。
 *
 * 规则启用（rewriteArmed()）时 pi 原生 `CacheWarmer` 的预热请求会被 traffic 改写（它复制会话的
 * `requestOptions`，票据可达），歧义路径下可能写出错误前缀 —— 故直接 `cache_warming_decision ⇒ {action:"stop"}`
 * 停掉 warming（T2b-report §9：这是第三轮裁定 A2 的否决端口消费点）。
 *
 * 与 traffic 自己的观察器（`src/traffic/index.ts` 的 `cache_warming_decision` 处理器）**互相独立**：
 * - 观察器只记录（60s 窗口 / 改写暂停的簿记归它，fail-closed 兜底 T5 缺席或被其它扩展改判的情况）；
 * - 本模块只否决（`isRewriteArmed()` 为真 ⇒ stop），不记账。
 *
 * T3 在 `wireTrafficHost` 与 `wireTrafficChild` **各调用一次**（每个 AgentSession 有自己的 warmer），
 * traffic off ⇒ 不注册（零面）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface WarmingVetoHandle {
  /** 注销（转发 pi.on 返回的 unsubscriber）。 */
  dispose(): void;
  /** `rewriteArmed` 判定抛错次数（读内存快照，不应抛；抛了按「不否决」fail-open 并 warn 一次）。 */
  readonly errors: number;
}

/** armed 判定：直接函数（作者 consult 裁定）或对象形式（T3 装配的调用形状，`{ rewriteArmed(): boolean }`）。 */
export type WarmingVetoArmed = (() => boolean) | { rewriteArmed(): boolean };

/**
 * 注册独立否决处理器。`armed` 建议传 `TrafficWiring.rewriteArmed()`（open ∧ 录制中 ∧ 有启用规则
 * ∧ !isSecure()），裸函数或 `{ rewriteArmed }` 对象均可。返回带 `dispose()` 的句柄（T3 在
 * session_shutdown / 释放时调用；不调用也只留下一个每次返回 undefined 的惰性处理器，无副作用）。
 */
export function registerWarmingVeto(pi: ExtensionAPI, armed: WarmingVetoArmed): WarmingVetoHandle {
  const isRewriteArmed = typeof armed === "function" ? armed : () => armed.rewriteArmed();
  let errors = 0;
  let warned = false;
  const off = pi.on("cache_warming_decision", () => {
    try {
      // 只在确实上膛时否决；undefined ⇒ 不改写 pi 的决策（默认放行与否由 pi 自己的经济学判定）。
      return isRewriteArmed() ? { action: "stop" } : undefined;
    } catch (err) {
      errors += 1;
      if (!warned) {
        warned = true;
        console.warn(
          `[pi-subagent] traffic: warming 否决端口抛错，本次放行（fail-open）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return undefined;
    }
  });
  return {
    dispose(): void {
      off();
    },
    get errors(): number {
      return errors;
    },
  };
}
