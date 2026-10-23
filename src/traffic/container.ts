/**
 * 进程级容器（traffic-merge plan §5.2）：`Symbol.for("pi-subagent:traffic")`。
 *
 * pi 以 `moduleCache:false` 加载扩展——主会话、每个子会话、每次 /reload 都是新模块实例，模块级变量
 * 不能承载进程级事实。进程内唯一的东西（单调纪元发号器、fetch trampoline 记录、主会话持有的 engine）
 * 放在这个全局容器上（HOST_KEY / secure-domain 先例）。
 *
 * 只在首次显式 DB 访问 / `/record on` 时创建；`traffic.enabled=false`、子会话、只读查询都**不创建**
 * （用 `peekTrafficGlobal()`）。容器创建后不删除（纪元必须单调），engine/tap 关闭后各自清空。
 */
import type { TrafficEngine } from "./engine.js";
import type { TapRecord } from "./tap.js";

export const TRAFFIC_GLOBAL_KEY = Symbol.for("pi-subagent:traffic");

export interface TrafficGlobal {
  readonly v: 1;
  /** 单调纪元发号器。 */
  epochSeq: number;
  /** 每进程一个 fetch trampoline 记录（首次安装时创建）。 */
  tap?: TapRecord;
  /** 主会话持有的 engine。 */
  engine?: TrafficEngine;
}

type GlobalBag = Record<symbol, unknown>;

export function peekTrafficGlobal(): TrafficGlobal | undefined {
  const value = (globalThis as GlobalBag)[TRAFFIC_GLOBAL_KEY] as TrafficGlobal | undefined;
  return value && value.v === 1 ? value : undefined;
}

export function ensureTrafficGlobal(): TrafficGlobal {
  const existing = peekTrafficGlobal();
  if (existing) return existing;
  const created: TrafficGlobal = { v: 1, epochSeq: 0 };
  (globalThis as GlobalBag)[TRAFFIC_GLOBAL_KEY] = created;
  return created;
}

export function nextEpoch(): number {
  const g = ensureTrafficGlobal();
  g.epochSeq += 1;
  return g.epochSeq;
}

/** 仅测试：删除容器（调用方负责先关闭 engine、退役 tap）。 */
export function resetTrafficGlobalForTest(): void {
  delete (globalThis as GlobalBag)[TRAFFIC_GLOBAL_KEY];
}
