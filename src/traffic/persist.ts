/**
 * 唯一落库闸口（traffic-merge plan §6）。
 *
 * 每次 `stmt.run()` / 事务提交**之前**同步复查 `!isSecure() && engine.state === "open" && engine.epoch === epoch`；
 * 任一失败 ⇒ 丢弃该写（计数 `droppedPersists`），secure 时把 engine 推入 closing。不保留跨 await 的 DB /
 * statement 引用：await 返回后一律经 `persist` 重新取连接。故 reload 后旧续体既不能写新库，也不能重开旧库。
 *
 * T2b：provider 热路径（钩子 / fetch 层 / 流捕获）的写一律进**写后账本**（db-port.ts，每 tick 预算），
 * 本文件的 `record*` 助手在入队时复查闸口（`persistAllowed`），账本在**每条执行前**再经 `drainAllowed`
 * 复查（secure / 纪元 / 未 closed）。`persist()` 同步写只留给命令与网页服务路径（非 provider 热路径）。
 *
 * `drainAllowed` 与 `persistAllowed` 的唯一差别：engine 处于 `closing` 时，**关闭前已被接纳**的条目仍可在
 * 有界排空（≤ closeBoundMs）中落库；新条目在 closing 时已被 `persistAllowed` 拒绝入队，故不存在复活录制的路径。
 */
import type { DatabaseSync } from "node:sqlite";
import { ensureDb } from "./db.js";
import { newRowRef, textBytes, type ChunkRow, type LazyText, type RowRef, type SqlValue } from "./db-port.js";
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

/**
 * secure 复查命中：**同步**只撤销接纳（`recording=false`：钩子 / wrapper 立即不再录），关闭延迟到当前调用栈
 * （尤其是账本的 flush tick）退出之后。安全评审 #2：闸口在 `runTick` 的循环条件里被调用，若同步 `engine.close()`
 * 会立刻进入 `dbPort.close()` 并重入同一队列的排空——外层随后 `shift()` 得到 undefined 而抛出未捕获异常。
 */
function closeForSecure(engine: TrafficEngine): void {
  engine.recording = false;
  if (engine.state !== "open" || engine.secureClosePending) return;
  engine.secureClosePending = true;
  setImmediate(() => {
    void engine.close("secure");
  });
}

/** 闸口判定（不执行写）。secure 命中时安排 engine 进入 closing（延迟，见 closeForSecure）。 */
export function persistAllowed(engine: TrafficEngine, epoch: number): boolean {
  if (isSecure()) {
    engine.counters.droppedPersists++;
    closeForSecure(engine);
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

/**
 * 账本执行前的闸口：secure ⇒ 丢弃并（延迟）推 closing；纪元不符 / 已 closed ⇒ 丢弃。closing 中已接纳的条目放行
 * （有界排空）。本函数在账本 flush 内被调用，**绝不**同步触发任何会重入账本的动作。
 */
export function drainAllowed(engine: TrafficEngine, epoch: number): boolean {
  if (isSecure()) {
    engine.counters.droppedPersists++;
    closeForSecure(engine);
    return false;
  }
  if (engine.state === "closed" || engine.epoch !== epoch) {
    engine.counters.droppedPersists++;
    return false;
  }
  return true;
}

/** 入队一个插入；闸口拒绝 ⇒ null。`onDone(rowId)` 在该行实际落库（COMMIT）后调用（SSE 广播用）。 */
export function recordInsert(
  engine: TrafficEngine,
  epoch: number,
  table: string,
  values: Record<string, SqlValue | LazyText>,
  onDone?: (rowId: number | null) => void,
): RowRef | null {
  if (!persistAllowed(engine, epoch)) return null;
  const ref = newRowRef();
  let bytes = 64;
  for (const v of Object.values(values)) bytes += typeof v === "string" ? textBytes(v) : 8;
  engine.dbPort.enqueue({ kind: "insert", epoch, table, values: { ...values }, ref, bytes, onDone });
  return ref;
}

/** 入队一个行补丁（同一行合并）。`coalesce` 中的列只在新值非 NULL 时覆盖已有值。 */
export function recordPatch(
  engine: TrafficEngine,
  epoch: number,
  ref: RowRef,
  table: string,
  set: Record<string, SqlValue>,
  opts: { coalesce?: string[]; onDone?: (rowId: number | null) => void } = {},
): boolean {
  if (!persistAllowed(engine, epoch)) return false;
  engine.dbPort.patch(epoch, ref, table, set, opts);
  return true;
}

/** 入队一条任意参数化 SQL（`rows` = 计入丢弃统计的行数）。 */
export function recordSql(
  engine: TrafficEngine,
  epoch: number,
  sql: string,
  params: SqlValue[],
  rows: number,
  onDone?: (rowId: number | null) => void,
): boolean {
  if (!persistAllowed(engine, epoch)) return false;
  let bytes = 64 + textBytes(sql);
  for (const v of params) bytes += typeof v === "string" ? textBytes(v) : 8;
  engine.dbPort.enqueue({ kind: "sql", epoch, sql, params, rows, bytes, onDone });
  return true;
}

/** 入队一个流 chunk（同一行合并为批）。闸口拒绝 ⇒ false（调用方取消读取）。 */
export function recordChunk(
  engine: TrafficEngine,
  epoch: number,
  ref: RowRef,
  sessionId: string,
  row: ChunkRow,
  onFail?: (err?: unknown) => void,
): boolean {
  if (!persistAllowed(engine, epoch)) return false;
  engine.dbPort.chunk(epoch, ref, sessionId, row, onFail);
  return true;
}
