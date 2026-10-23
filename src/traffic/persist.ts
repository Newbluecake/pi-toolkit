/**
 * 唯一落库闸口（traffic-merge plan §6）。
 *
 * 每次 `stmt.run()` / 事务提交**之前**同步复查 `!isSecure() && engine.state === "open" && engine.epoch === epoch`；
 * 任一失败 ⇒ 丢弃该写（计数 `droppedPersists`），secure 时把 engine 推入 closing。不保留跨 await 的 DB /
 * statement 引用：await 返回后一律经 `persist` 重新取连接。故 reload 后旧续体既不能写新库，也不能重开旧库。
 *
 * T2b 在此之上加写后账本与每 tick 预算（§3.2）；闸口语义不变。
 */
import type { DatabaseSync } from "node:sqlite";
import { ensureDb } from "./db.js";
import type { TrafficEngine } from "./engine.js";
import { isSecure } from "./secure.js";

/** 续体入口捕获的租约：engine 引用 + 当时的纪元。 */
export interface EngineLease {
  readonly engine: TrafficEngine;
  readonly epoch: number;
}

export function leaseOf(engine: TrafficEngine): EngineLease {
  return { engine, epoch: engine.epoch };
}

/** 闸口判定（不执行写）。secure 命中时推 engine 进入 closing。 */
export function persistAllowed(engine: TrafficEngine, epoch: number): boolean {
  if (isSecure()) {
    engine.counters.droppedPersists++;
    if (engine.state === "open") void engine.close("secure");
    return false;
  }
  if (engine.state !== "open" || engine.epoch !== epoch) {
    engine.counters.droppedPersists++;
    return false;
  }
  return true;
}

/**
 * 经闸口执行一次写。返回 `op` 的结果，或在闸口拒绝时返回 `undefined`（丢弃）。`op` 自身抛错原样上抛
 * （调用方按原逻辑记 dbError）。
 */
export function persist<T>(engine: TrafficEngine, epoch: number, op: (db: DatabaseSync) => T): T | undefined {
  if (!persistAllowed(engine, epoch)) return undefined;
  return op(ensureDb(engine));
}
