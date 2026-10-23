/**
 * DbPort：写后账本 + 每 tick 工作预算（traffic-merge plan §3.2，r3 裁定 R1-9）。
 *
 * 同步 SQLite 与 provider 续体共用一个线程。这里保证主线程**从不等锁、从不做无界同步工作**：
 *
 * - `PRAGMA busy_timeout = 0`（db.ts）：遇锁立即 `SQLITE_BUSY`。
 * - **写后账本**：钩子与 fetch 层只把记录意图推入内存账本（`enqueue`），provider 请求从不等待 DB。
 *   同一行的多次更新（线级头、状态、改写结果）按行合并为一个补丁；行尚未插入时直接并入插入值。
 * - **flush tick**：unref 的 `setImmediate` 调度（不用 queueMicrotask：provider 已排队的微任务与 I/O 回调先跑）。
 *   每个 tick：`BEGIN IMMEDIATE` 一次（BUSY ⇒ 立即放弃本 tick，unref `setTimeout` 退避 10→20→40…→500ms）→
 *   依次执行账本条目，每条后检查 2ms 预算，超出即 `COMMIT` 让出 → 下个 tick 继续。单 tick 最多 1 次 BUSY 尝试。
 * - **WAL checkpoint 独占 tick**：SQLite 缺省在 COMMIT 内做自动 checkpoint（实测 1 MiB 级写累积 ~4 MiB 后一次 COMMIT
 *   17ms）。本连接 `wal_autocheckpoint=0`（连接级，不影响其它连接 / 进程），改为每写入 ≥1 MiB 由一个**单独的** tick
 *   执行 `wal_checkpoint(PASSIVE)`（不等读者、不取写锁之外的锁；实测 ~2.8ms/MiB），把成本摊成有界小块。
 *   **工作量上界**（安全评审 #6 / 第三轮裁定 B）：PASSIVE 没有页数预算，一次 checkpoint 的工作量至多是当时 WAL 里的
 *   全部帧。故每次决定前**现场 stat 真实 `-wal` 文件大小**（`walSize()`；不用上次 checkpoint 结果估算）：≤
 *   `checkpointMaxBytes`（缺省 2 MiB，约 5.6ms）才执行，否则跳过并计 `checkpointsDeferred`。首次积压（上个进程留下的
 *   WAL）、长读者钉住导致的积压、外部连接写入的 WAL 都被这一判据覆盖；stat 失败 ⇒ 跳过（fail closed）。跳过之后 WAL
 *   会继续增长（文件不回缩），直到 engine 关闭时 `db.close()` 的隐式 checkpoint（已接受残留：在 shutdown / reload，
 *   不在发送路径；engine 关闭前 WAL > 64 MiB 时 console.warn 一行）。
 * - **大条目**：> 256 KiB 的条目独占一个 tick（之前先提交已累积的小条目）；单条执行时间计入 `maxStmtMs`。
 * - **有界**（硬上限，安全评审 #5）：≤512 条 / ≤8 MiB（UTF-8 字节，`Buffer.byteLength`）。入队、行补丁合并、chunk 批
 *   追加、延迟值物化——每条使缓冲增长的路径之后都做同一次限额检查：单条超过 8 MiB 的条目直接丢弃（`oversize`），
 *   其余溢出 FIFO 丢最旧并计数 `droppedRows`（按「本应落库的行数」计）。被丢插入的
 *   行引用标记 `dropped`，依赖它的补丁 / chunk 在执行时跳过（`orphanOps`），**绝不写到别的行**（无行错位）。
 * - **流 chunk**：同一行的连续 chunk 合并为一个批（≤64 块或首块后 250ms 封批），批内逐块一行插入。
 * - **读也受预算**：`pages()` 以 keyset 分页（≤200 行/页），页内每行后检查 2ms 预算，超出即在下一个
 *   `setImmediate` 从游标继续；`query()` 收集全部页并受截止时间约束。不提供单次全表同步读。
 * - **落库闸口**：每条执行前经 `gate(entry.epoch)` 复查（secure / engine 纪元 / 未 closed；persist.ts 的
 *   `drainAllowed`）。闸口拒绝 ⇒ 丢弃（计入 `droppedPersists`，由闸口自身计数）。
 * - **不是 r2 的熔断**：r3 去掉了熔断，持续锁竞争由账本上限兜底；连续 BUSY 超过 30s 只 notify 一次，退避保持 500ms。
 *
 * worker 实现（T2c，仅硬门不达标时）：同一接口，`WriteOp` 已是可序列化的数据（SQL + 参数），行引用与回调留在主线程。
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export type SqlValue = SQLInputValue;

/**
 * 延迟物化的文本值（例如 1 MiB payload 的 JSON.stringify）：provider 热路径只保存引用，由账本在**单独的、
 * 不需要锁的** tick 中物化（每 tick 预算 2ms，至少 1 条），之后按真实大小参与上限与大条目判定。
 */
export interface LazyText {
  readonly lazy: () => string;
}

export function lazyText(fn: () => string): LazyText {
  return { lazy: fn };
}

function isLazy(v: unknown): v is LazyText {
  return typeof v === "object" && v !== null && typeof (v as LazyText).lazy === "function";
}

/** 主线程行引用：插入执行后得到 rowId；插入被丢弃 / 失败 ⇒ `dropped`，依赖它的写全部跳过。 */
export interface RowRef {
  rowId: number | null;
  dropped: boolean;
  /** 插入前到达的补丁直接并入插入值（同一条 INSERT）。内部使用。 */
  pendingInsert?: InsertEntry | null;
  /** 尚未执行的合并补丁。内部使用。 */
  pendingPatch?: PatchEntry | null;
  /** 正在累积的 chunk 批。内部使用。 */
  openBatch?: ChunkEntry | null;
}

export function newRowRef(rowId: number | null = null): RowRef {
  return { rowId, dropped: false, pendingInsert: null, pendingPatch: null, openBatch: null };
}

export interface ChunkRow {
  seq: number;
  ts: string;
  elapsedMs: number;
  data: string;
}

interface BaseEntry {
  readonly epoch: number;
  bytes: number;
  /** 执行成功后（COMMIT 之后）调用。 */
  onDone?: ((rowId: number | null) => void) | undefined;
  /** 执行失败（非 BUSY 的语句错误）/ 被丢弃时调用。 */
  onFail?: ((reason: "error" | "dropped" | "gate", err?: unknown) => void) | undefined;
}

export interface InsertEntry extends BaseEntry {
  readonly kind: "insert";
  readonly table: string;
  readonly values: Record<string, SqlValue | LazyText>;
  readonly ref: RowRef;
}

export interface PatchEntry extends BaseEntry {
  readonly kind: "patch";
  readonly table: string;
  readonly set: Record<string, SqlValue>;
  /** 列 → 仅当原值为 NULL 时才写（COALESCE(列, ?) 语义的反向：保留已有值用 keepExisting）。 */
  readonly coalesce: Set<string>;
  readonly ref: RowRef;
  readonly doneHooks: Array<(rowId: number | null) => void>;
}

export interface ChunkEntry extends BaseEntry {
  readonly kind: "chunks";
  readonly ref: RowRef;
  readonly sessionId: string;
  readonly rows: ChunkRow[];
  sealed: boolean;
  openedAt: number;
}

export interface SqlEntry extends BaseEntry {
  readonly kind: "sql";
  readonly sql: string;
  readonly params: SqlValue[];
  /** 计入 droppedRows 的行数（例如 messages 插入 = 1；upsert session = 0）。 */
  readonly rows: number;
}

export interface MarkEntry extends BaseEntry {
  readonly kind: "mark";
  readonly ref: RowRef;
}

export type LedgerEntry = InsertEntry | PatchEntry | ChunkEntry | SqlEntry | MarkEntry;

export interface ReadQuery {
  /** 表名（内部常量，不来自用户输入）。 */
  table: string;
  /** 列（内部常量）；必须包含 `id`（keyset 游标）。 */
  columns: string;
  /** 额外 WHERE 条件（不含游标），参数化。 */
  where?: string;
  params?: SqlValue[];
  order?: "asc" | "desc";
  /** 每页上限，缺省且最大 200。 */
  pageSize?: number;
  /** 最多读多少行（缺省不限，受 deadline 约束）。 */
  limit?: number;
}

export type Rows = Array<Record<string, unknown>>;

export interface DbStats {
  queued: number;
  queuedBytes: number;
  droppedRows: number;
  droppedByKind: Record<string, number>;
  orphanOps: number;
  busyBackoffs: number;
  maxStmtMs: number;
  maxTickMs: number;
  ticks: number;
  writeErrors: number;
  checkpoints: number;
  maxCheckpointMs: number;
  /** 因 WAL 积压估计超过 checkpointMaxBytes 而跳过的 checkpoint 次数。 */
  checkpointsDeferred: number;
  /** 最近一次决定 checkpoint 时现场 stat 到的 `-wal` 文件大小（字节；null = 尚未观测 / stat 失败）。 */
  walBytes: number | null;
  /** 当前退避（ms），0 = 无。 */
  backoffMs: number;
}

export interface DbPort {
  enqueue(entry: LedgerEntry): void;
  /** 合并一个行补丁（同一行未执行的补丁合并；插入未执行 ⇒ 并入插入值）。 */
  patch(
    epoch: number,
    ref: RowRef,
    table: string,
    set: Record<string, SqlValue>,
    opts?: { coalesce?: string[]; onDone?: (rowId: number | null) => void },
  ): void;
  /** 追加一个流 chunk（同一行合并为批）。 */
  chunk(epoch: number, ref: RowRef, sessionId: string, row: ChunkRow, onFail?: (err?: unknown) => void): void;
  /** 封闭该行的 chunk 批（流结束），并在其全部前序写落库后调用 onDone。 */
  sealChunks(epoch: number, ref: RowRef, onDone?: (rowId: number | null) => void): void;
  query(q: ReadQuery, deadlineMs: number): Promise<Rows>;
  pages(q: ReadQuery, opts?: { deadlineMs?: number; signal?: AbortSignal }): AsyncIterable<Rows>;
  /** 账本清空（含退避中的条目）时 resolve；超时 resolve false。 */
  whenIdle(timeoutMs?: number): Promise<boolean>;
  /** 有界排空（关闭路径）：在截止前尽量落库，之后丢弃剩余条目。 */
  close(deadlineMs: number): Promise<void>;
  stats(): DbStats;
}

export interface InThreadDbPortOptions {
  /** 取连接；抛错 ⇒ 本 tick 放弃（engine 关闭 / 无库）。 */
  getDb: () => DatabaseSync | null;
  /** 落库闸口（每条执行前复查）。 */
  gate: (epoch: number) => boolean;
  onError?: (err: unknown) => void;
  notify?: (message: string) => void;
  now?: () => number;
  /** 测试可调：每 tick 预算（ms），缺省 2。 */
  tickBudgetMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  largeEntryBytes?: number;
  chunkBatchMax?: number;
  chunkBatchMs?: number;
  /** 每累积写入多少字节做一次独占 tick 的 PASSIVE checkpoint；0 = 交还 SQLite 自动 checkpoint。缺省 1 MiB。 */
  checkpointBytes?: number;
  /** 单次 checkpoint 工作量上限（字节，以 `-wal` 文件实际大小为界）；超过 ⇒ 跳过（见文件头）。缺省 2 MiB。 */
  checkpointMaxBytes?: number;
  /**
   * 现场读取 `-wal` 文件大小（字节）。文件不存在 ⇒ 0；无法判定 ⇒ null（跳过 checkpoint）。未提供 ⇒ 无法证明有界，
   * 一律不做运行时 checkpoint。
   */
  walSize?: () => number | null;
}

const BACKOFF_MIN_MS = 10;
const BACKOFF_MAX_MS = 500;
const BUSY_NOTIFY_AFTER_MS = 30_000;
const PAGE_MAX = 200;

function isBusy(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string } | null;
  if (!e) return false;
  if (e.errcode === 5 || e.errcode === 6) return true; // SQLITE_BUSY / SQLITE_LOCKED
  return typeof e.message === "string" && /database is locked|database table is locked/i.test(e.message);
}

/** 账本统一的字节口径：字符串按 UTF-8 编码字节（不是 UTF-16 码元数）。 */
export function textBytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function valueBytes(v: SqlValue): number {
  if (typeof v === "string") return textBytes(v);
  if (v instanceof Uint8Array) return v.byteLength;
  return 8;
}

function sizeOf(values: Record<string, SqlValue | LazyText>): number {
  let n = 64;
  for (const v of Object.values(values)) n += isLazy(v) ? 0 : valueBytes(v);
  return n;
}

function hasLazy(e: LedgerEntry): boolean {
  return e.kind === "insert" && Object.values(e.values).some(isLazy);
}

function rowsOf(entry: LedgerEntry): number {
  switch (entry.kind) {
    case "insert":
      return 1;
    case "chunks":
      return entry.rows.length;
    case "sql":
      return entry.rows;
    default:
      return 0;
  }
}

function unref(timer: unknown): void {
  (timer as { unref?: () => void } | null)?.unref?.();
}

const IDENT = /^[a-z_][a-z0-9_]*$/i;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid identifier ${name}`);
  return name;
}

export function createInThreadDbPort(opts: InThreadDbPortOptions): DbPort {
  const now = opts.now ?? (() => performance.now());
  const tickBudgetMs = opts.tickBudgetMs ?? 2;
  const maxEntries = opts.maxEntries ?? 512;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const largeEntryBytes = opts.largeEntryBytes ?? 256 * 1024;
  const chunkBatchMax = opts.chunkBatchMax ?? 64;
  const chunkBatchMs = opts.chunkBatchMs ?? 250;
  const checkpointBytes = opts.checkpointBytes ?? 1024 * 1024;
  const checkpointMaxBytes = opts.checkpointMaxBytes ?? 2 * 1024 * 1024;
  let sinceCheckpoint = 0;
  let walBytes: number | null = null;
  /** runTick 重入守卫（安全评审 #2）；运行中发生的缓冲增长只登记，tick 结束后统一做限额检查。 */
  let running = false;
  let enforcePending = false;
  const configured = new WeakSet<DatabaseSync>();

  const queue: LedgerEntry[] = [];
  let queuedBytes = 0;
  let scheduled: ReturnType<typeof setImmediate> | null = null;
  let materializeScheduled: ReturnType<typeof setImmediate> | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = 0;
  let busySince: number | null = null;
  let busyNotified = false;
  let closed = false;
  const idleWaiters = new Set<() => void>();
  const stats = {
    droppedRows: 0,
    droppedByKind: {} as Record<string, number>,
    orphanOps: 0,
    busyBackoffs: 0,
    maxStmtMs: 0,
    maxTickMs: 0,
    ticks: 0,
    writeErrors: 0,
    checkpoints: 0,
    maxCheckpointMs: 0,
    checkpointsDeferred: 0,
  };

  const fire = (fn: (() => void) | undefined): void => {
    if (!fn) return;
    try {
      fn();
    } catch {
      // 回调失败不影响账本。
    }
  };

  function detach(entry: LedgerEntry): void {
    if (entry.kind === "insert" && entry.ref.pendingInsert === entry) entry.ref.pendingInsert = null;
    if (entry.kind === "patch" && entry.ref.pendingPatch === entry) entry.ref.pendingPatch = null;
    if (entry.kind === "chunks" && entry.ref.openBatch === entry) entry.ref.openBatch = null;
  }

  function drop(entry: LedgerEntry, reason: "dropped" | "gate" | "oversize"): void {
    detach(entry);
    const rows = rowsOf(entry);
    if (reason !== "gate") {
      stats.droppedRows += rows;
      const key = reason === "oversize" ? "oversize" : entry.kind;
      stats.droppedByKind[key] = (stats.droppedByKind[key] ?? 0) + (rows || 1);
    }
    if (entry.kind === "insert") entry.ref.dropped = true;
    fire(() => entry.onFail?.(reason === "gate" ? "gate" : "dropped"));
  }

  function settleIdle(): void {
    if (queue.length > 0) return;
    for (const resolve of [...idleWaiters]) resolve();
    idleWaiters.clear();
  }

  /**
   * 统一限额检查（硬上限）：先丢单条超限（> maxBytes）的条目，再 FIFO 丢最旧直到 ≤maxEntries 且 ≤maxBytes。
   * runTick 运行中只登记，tick 结束后执行（迭代中途不改队列）。
   */
  function trim(): void {
    if (running) {
      enforcePending = true;
      return;
    }
    if (queuedBytes > maxBytes) {
      for (let i = queue.length - 1; i >= 0; i--) {
        const e = queue[i]!;
        if (e.bytes <= maxBytes) continue;
        queue.splice(i, 1);
        queuedBytes -= e.bytes;
        drop(e, "oversize");
      }
    }
    while (queue.length > maxEntries || queuedBytes > maxBytes) {
      const oldest = queue.shift();
      if (!oldest) break;
      queuedBytes -= oldest.bytes;
      drop(oldest, "dropped");
    }
    if (queue.length === 0) {
      queuedBytes = 0;
      settleIdle();
    }
  }

  /** 条目原地增长 delta 字节（合并补丁 / chunk 追加 / 物化）之后：计入并做限额检查。 */
  function grow(e: LedgerEntry, delta: number): void {
    e.bytes += delta;
    queuedBytes += delta;
  }

  function push(entry: LedgerEntry): void {
    if (closed) {
      drop(entry, "gate");
      return;
    }
    queue.push(entry);
    queuedBytes += entry.bytes;
    trim();
    if (hasLazy(entry)) scheduleMaterialize();
    schedule();
  }

  /** 物化一个条目的延迟值（真实大小计入上限）。 */
  function materialize(e: LedgerEntry): void {
    if (e.kind !== "insert") return;
    const values = e.values as Record<string, SqlValue | LazyText>;
    for (const [k, v] of Object.entries(values)) {
      if (!isLazy(v)) continue;
      let text: string;
      try {
        text = v.lazy();
      } catch (err) {
        text = "null";
        fire(() => opts.onError?.(err));
      }
      values[k] = text;
      grow(e, textBytes(text));
    }
  }

  function scheduleMaterialize(): void {
    if (materializeScheduled || closed) return;
    // 物化不需要锁：独立于写 tick 与 BUSY 退避调度（持锁期间也按预算物化，真实大小才能让 8 MiB 上限生效）。
    materializeScheduled = setImmediate(materializeTick);
  }

  function materializeTick(): void {
    materializeScheduled = null;
    if (closed) return;
    const t0 = now();
    let more = false;
    for (const e of queue) {
      if (!hasLazy(e)) continue;
      if (now() - t0 >= tickBudgetMs) {
        more = true;
        break;
      }
      const s0 = now();
      materialize(e);
      const ms = now() - s0;
      if (ms > stats.maxStmtMs) stats.maxStmtMs = ms;
    }
    const tickMs = now() - t0;
    if (tickMs > stats.maxTickMs) stats.maxTickMs = tickMs;
    trim();
    if (more) scheduleMaterialize();
    schedule();
  }

  function schedule(): void {
    if (scheduled || backoffTimer || closed || queue.length === 0) return;
    // 注意：**不** unref。Node 里 unref 的 Immediate 不计入「有待处理 immediate」的引用计数，poll 阶段会照常
    // 阻塞等 I/O / 下一个定时器——实测 flush 被拖延到 ~2s 后（jq 超时定时器）。ref 的 Immediate 只多占一次
    // 事件循环迭代（tick 结束即释放），不会让 print 模式进程挂住；退避 / 封批定时器仍全部 unref。
    scheduled = setImmediate(tick);
  }

  function armBatchTimer(): void {
    if (batchTimer) return;
    batchTimer = setTimeout(() => {
      batchTimer = null;
      const t = now();
      for (const e of queue) {
        if (e.kind === "chunks" && !e.sealed && t - e.openedAt >= chunkBatchMs) seal(e);
      }
      schedule();
      if (queue.some((e) => e.kind === "chunks" && !e.sealed)) armBatchTimer();
    }, chunkBatchMs);
    unref(batchTimer);
  }

  function seal(e: ChunkEntry): void {
    e.sealed = true;
    if (e.ref.openBatch === e) e.ref.openBatch = null;
  }

  function ready(e: LedgerEntry): boolean {
    return e.kind !== "chunks" || e.sealed;
  }

  /** 执行一条（事务内）。返回 false = 跳过（孤儿 / 闸口）。 */
  function exec(db: DatabaseSync, e: LedgerEntry): { rowId: number | null } | null {
    switch (e.kind) {
      case "insert": {
        detach(e);
        const cols = Object.keys(e.values);
        const sql = `INSERT INTO ${ident(e.table)} (${cols.map(ident).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
        const result = db.prepare(sql).run(...cols.map((c) => e.values[c] as SqlValue));
        // （执行前已物化；hasLazy 的条目不会走到这里。）
        return { rowId: Number(result.lastInsertRowid) };
      }
      case "patch": {
        detach(e);
        if (e.ref.dropped || e.ref.rowId === null) {
          stats.orphanOps++;
          return null;
        }
        const cols = Object.keys(e.set);
        if (cols.length === 0) return { rowId: e.ref.rowId };
        const assigns = cols.map((c) =>
          e.coalesce.has(c) ? `${ident(c)} = COALESCE(?, ${ident(c)})` : `${ident(c)} = ?`,
        );
        db.prepare(`UPDATE ${ident(e.table)} SET ${assigns.join(", ")} WHERE id = ?`).run(
          ...cols.map((c) => e.set[c] as SqlValue),
          e.ref.rowId,
        );
        return { rowId: e.ref.rowId };
      }
      case "chunks": {
        if (e.ref.dropped || e.ref.rowId === null) {
          stats.orphanOps++;
          return null;
        }
        const stmt = db.prepare(
          "INSERT INTO stream_chunks (request_id, session_id, seq, ts, elapsed_ms, data) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const r of e.rows) stmt.run(e.ref.rowId, e.sessionId, r.seq, r.ts, r.elapsedMs, r.data);
        return { rowId: e.ref.rowId };
      }
      case "sql": {
        db.prepare(e.sql).run(...e.params);
        return { rowId: null };
      }
      case "mark":
        return { rowId: e.ref.dropped ? null : e.ref.rowId };
    }
  }

  function backoff(): void {
    stats.busyBackoffs++;
    backoffMs = backoffMs === 0 ? BACKOFF_MIN_MS : Math.min(BACKOFF_MAX_MS, backoffMs * 2);
    const t = now();
    busySince ??= t;
    if (!busyNotified && t - busySince >= BUSY_NOTIFY_AFTER_MS) {
      busyNotified = true;
      fire(() =>
        opts.notify?.("traffic：数据库被其它连接持续锁定超过 30s，录制写入在内存中有界缓冲（溢出会丢弃并计数）"),
      );
    }
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      schedule();
    }, backoffMs);
    unref(backoffTimer);
  }

  /** 一个 flush tick。返回本 tick 是否取得了锁。 */
  function tick(): void {
    scheduled = null;
    if (closed) return;
    runTick();
  }

  /** 重入守卫：闸口 / 回调里即使同步走到 close() 或 schedule 的 tick，也不会在外层迭代中途改队列。 */
  function runTick(): boolean {
    if (running) return false;
    running = true;
    try {
      return runTickInner();
    } finally {
      running = false;
      if (enforcePending) {
        enforcePending = false;
        trim();
        if (queue.length === 0) settleIdle();
      }
    }
  }

  function runTickInner(): boolean {
    // 前导：丢掉闸口拒绝的条目（无需锁）。每次取元素后重验其存在（闸口回调不得改队列，但这里不依赖该约定）。
    for (;;) {
      const head = queue[0];
      if (!head || !ready(head) || opts.gate(head.epoch)) break;
      if (queue[0] !== head) continue;
      queue.shift();
      queuedBytes -= head.bytes;
      drop(head, "gate");
    }
    if (queue.length === 0) {
      settleIdle();
      return true;
    }
    const firstReady = queue.findIndex(ready);
    if (firstReady < 0) {
      armBatchTimer();
      return true;
    }
    let db: DatabaseSync | null;
    try {
      db = opts.getDb();
    } catch (err) {
      db = null;
      fire(() => opts.onError?.(err));
    }
    if (db && checkpointBytes > 0 && !configured.has(db)) {
      configured.add(db);
      try {
        db.exec("PRAGMA wal_autocheckpoint = 0");
        // WAL 复位（完整 checkpoint 后下一次写从头开始）时把文件截到上限：否则文件大小停在历史高水位，
        // 「现场 stat ≤ 上限」的判据会被一次性的大写入永久卡住。
        db.exec(`PRAGMA journal_size_limit = ${Math.max(0, Math.floor(checkpointBytes))}`);
      } catch {}
    }
    const nextReady = queue[firstReady];
    const nextBytes = nextReady && !hasLazy(nextReady) ? nextReady.bytes : 0;
    if (
      db &&
      checkpointBytes > 0 &&
      sinceCheckpoint > 0 &&
      // 每写满 checkpointBytes 一次；或下一条（大条目）写入后 WAL 会超过上限 ⇒ 先 checkpoint，让 WAL 尽量从小开始。
      (sinceCheckpoint >= checkpointBytes || sinceCheckpoint + nextBytes > checkpointMaxBytes)
    ) {
      let size: number | null = null;
      try {
        size = opts.walSize ? opts.walSize() : null;
      } catch {
        size = null;
      }
      walBytes = size;
      if (size === null || size > checkpointMaxBytes) {
        // 不能证明工作量 ≤ checkpointMaxBytes：不在本线程做（见文件头）。本 tick 照常写（不 return）。
        stats.checkpointsDeferred++;
        sinceCheckpoint = 0;
      } else {
        // 独占 tick：只做 checkpoint，下一个 tick 再写。
        const c0 = now();
        try {
          db.exec("PRAGMA wal_checkpoint(PASSIVE)");
          sinceCheckpoint = 0;
          stats.checkpoints++;
        } catch (err) {
          if (!isBusy(err)) fire(() => opts.onError?.(err));
          sinceCheckpoint = 0; // 下一轮累积后再试，绝不在本线程等
        }
        const cm = now() - c0;
        if (cm > stats.maxCheckpointMs) stats.maxCheckpointMs = cm;
        if (cm > stats.maxTickMs) stats.maxTickMs = cm;
        schedule();
        return true;
      }
    }
    if (!db) {
      // 无库（engine 关闭 / 打开失败）：全部丢弃（闸口语义）。
      for (const e of queue.splice(0)) drop(e, "gate");
      queuedBytes = 0;
      settleIdle();
      return true;
    }
    const t0 = now();
    stats.ticks++;
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (err) {
      if (isBusy(err)) {
        backoff();
        return false;
      }
      stats.writeErrors++;
      fire(() => opts.onError?.(err));
      backoff();
      return false;
    }
    const done: Array<{ e: LedgerEntry; rowId: number | null }> = [];
    let executed = 0;
    let i = 0;
    while (i < queue.length) {
      const e = queue[i]!;
      if (!ready(e)) {
        i++;
        continue;
      }
      if (hasLazy(e)) {
        // 尚未物化（物化 tick 还没轮到）：留给物化 tick，本 tick 到此为止（保持 FIFO）。
        scheduleMaterialize();
        break;
      }
      const large = e.bytes > largeEntryBytes;
      if (large && executed > 0) break; // 大条目独占一个 tick：先提交已累积的小条目
      queue.splice(i, 1);
      queuedBytes -= e.bytes;
      if (!opts.gate(e.epoch)) {
        drop(e, "gate");
        continue;
      }
      const s0 = now();
      try {
        const r = exec(db, e);
        if (r) {
          if (e.kind === "insert") e.ref.rowId = r.rowId;
          done.push({ e, rowId: r.rowId });
        } else {
          fire(() => e.onFail?.("dropped"));
        }
      } catch (err) {
        if (e.kind === "insert") e.ref.dropped = true;
        stats.writeErrors++;
        fire(() => opts.onError?.(err));
        fire(() => e.onFail?.("error", err));
      }
      const stmtMs = now() - s0;
      if (stmtMs > stats.maxStmtMs) stats.maxStmtMs = stmtMs;
      executed++;
      if (large || now() - t0 >= tickBudgetMs) break;
    }
    try {
      db.exec("COMMIT");
    } catch (err) {
      // COMMIT 失败（极少：WAL 下持 RESERVED 后不会 BUSY）：回滚，本 tick 已执行条目视为丢弃（不重放：避免重复插入）。
      try {
        db.exec("ROLLBACK");
      } catch {}
      stats.writeErrors++;
      fire(() => opts.onError?.(err));
      for (const { e } of done) {
        if (e.kind === "insert") {
          e.ref.rowId = null;
          e.ref.dropped = true;
        }
        stats.droppedRows += rowsOf(e);
        fire(() => e.onFail?.("error", err));
      }
      backoff();
      return true;
    }
    backoffMs = 0;
    busySince = null;
    for (const { e } of done) sinceCheckpoint += e.bytes;
    const tickMs = now() - t0;
    if (tickMs > stats.maxTickMs) stats.maxTickMs = tickMs;
    for (const { e, rowId } of done) {
      if (e.onDone) fire(() => e.onDone!(rowId));
      if (e.kind === "patch") for (const hook of e.doneHooks) fire(() => hook(rowId));
    }
    if (queue.some((e) => e.kind === "chunks" && !e.sealed)) armBatchTimer();
    if (queue.length > 0) schedule();
    else settleIdle();
    return true;
  }

  function patch(
    epoch: number,
    ref: RowRef,
    table: string,
    set: Record<string, SqlValue>,
    o: { coalesce?: string[]; onDone?: (rowId: number | null) => void } = {},
  ): void {
    if (ref.dropped) {
      stats.orphanOps++;
      return;
    }
    const insert = ref.pendingInsert;
    if (insert && insert.table === table && insert.epoch === epoch) {
      // 插入尚未执行：并入插入值（coalesce 列只在新值非 NULL 时覆盖）。
      for (const [k, v] of Object.entries(set)) {
        if (o.coalesce?.includes(k) && v === null) continue;
        const prev = insert.values[k];
        (insert.values as Record<string, SqlValue | LazyText>)[k] = v;
        grow(insert, valueBytes(v) - (prev === undefined || isLazy(prev) ? 0 : valueBytes(prev)));
      }
      if (o.onDone) {
        const prevDone = insert.onDone;
        insert.onDone = (rowId) => {
          prevDone?.(rowId);
          o.onDone!(rowId);
        };
      }
      trim();
      return;
    }
    const pending = ref.pendingPatch;
    if (pending && pending.table === table && pending.epoch === epoch) {
      for (const [k, v] of Object.entries(set)) {
        if (o.coalesce?.includes(k)) {
          if (v === null) {
            if (!(k in pending.set)) {
              (pending.set as Record<string, SqlValue>)[k] = null;
              pending.coalesce.add(k);
            }
            continue;
          }
          pending.coalesce.delete(k);
        } else {
          pending.coalesce.delete(k);
        }
        const prev = pending.set[k];
        (pending.set as Record<string, SqlValue>)[k] = v;
        grow(pending, valueBytes(v) - (prev === undefined ? 0 : valueBytes(prev)));
      }
      if (o.onDone) pending.doneHooks.push(o.onDone);
      trim();
      return;
    }
    const entry: PatchEntry = {
      kind: "patch",
      epoch,
      table,
      set: { ...set },
      coalesce: new Set(o.coalesce ?? []),
      ref,
      bytes: sizeOf(set),
      doneHooks: o.onDone ? [o.onDone] : [],
    };
    ref.pendingPatch = entry;
    push(entry);
  }

  function chunk(epoch: number, ref: RowRef, sessionId: string, row: ChunkRow, onFail?: (err?: unknown) => void): void {
    if (ref.dropped) {
      stats.orphanOps++;
      fire(() => onFail?.());
      return;
    }
    let batch = ref.openBatch;
    if (!batch || batch.sealed || batch.epoch !== epoch) {
      batch = {
        kind: "chunks",
        epoch,
        ref,
        sessionId,
        rows: [],
        sealed: false,
        openedAt: now(),
        bytes: 64,
        onFail: onFail ? (_reason, err) => onFail(err) : undefined,
      };
      ref.openBatch = batch;
      batch.rows.push(row);
      batch.bytes += textBytes(row.data) + 48;
      push(batch);
    } else {
      batch.rows.push(row);
      grow(batch, textBytes(row.data) + 48);
      trim();
    }
    if (batch.rows.length >= chunkBatchMax) {
      seal(batch);
      schedule();
    } else {
      armBatchTimer();
    }
  }

  function sealChunks(epoch: number, ref: RowRef, onDone?: (rowId: number | null) => void): void {
    if (ref.openBatch) seal(ref.openBatch);
    push({ kind: "mark", epoch, ref, bytes: 16, onDone });
  }

  function enqueue(entry: LedgerEntry): void {
    if (entry.kind === "insert") entry.ref.pendingInsert = entry;
    push(entry);
  }

  async function* pages(q: ReadQuery, o: { deadlineMs?: number; signal?: AbortSignal } = {}): AsyncIterable<Rows> {
    const pageSize = Math.max(1, Math.min(PAGE_MAX, q.pageSize ?? PAGE_MAX));
    const desc = q.order === "desc";
    const deadline = o.deadlineMs !== undefined ? now() + o.deadlineMs : Infinity;
    let cursor: number | null = null;
    let total = 0;
    for (;;) {
      if (o.signal?.aborted) return;
      if (now() > deadline) throw new Error("traffic: 读取超时");
      const db = opts.getDb();
      if (!db) return;
      const conds: string[] = [];
      const params: SqlValue[] = [];
      if (q.where) {
        conds.push(`(${q.where})`);
        params.push(...(q.params ?? []));
      }
      if (cursor !== null) {
        conds.push(desc ? "id < ?" : "id > ?");
        params.push(cursor);
      }
      const remaining = q.limit !== undefined ? q.limit - total : pageSize;
      const take = Math.min(pageSize, remaining);
      if (take <= 0) return;
      const sql = `SELECT ${q.columns} FROM ${ident(q.table)}${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""} ORDER BY id ${desc ? "DESC" : "ASC"} LIMIT ?`;
      const t0 = now();
      const out: Rows = [];
      let exhausted = true;
      // for-of 的 break 会调用迭代器 return()，释放语句。
      for (const row of db.prepare(sql).iterate(...params, take) as Iterable<Record<string, unknown>>) {
        out.push(row);
        cursor = Number(row.id);
        // keyset 游标依赖整数 id：缺列 / 非整数会让下一页 `id > NaN` 静默丢行——直接报错。
        if (!Number.isSafeInteger(cursor)) throw new Error(`traffic: pages(${q.table}) 的 columns 必须包含整数 id`);
        if (now() - t0 >= tickBudgetMs && out.length < take) {
          exhausted = false;
          break;
        }
      }
      total += out.length;
      if (out.length === take) exhausted = false;
      if (out.length > 0) yield out;
      if (exhausted) {
        // 返回前也让出：消费方若在循环里反复调用 pages()（空表 / 短表立即结束），不至于形成微任务死循环。
        await new Promise<void>((resolve) => setImmediate(resolve));
        return;
      }
      // 让出（ref 的 Immediate，理由同 schedule()）。
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async function query(q: ReadQuery, deadlineMs: number): Promise<Rows> {
    const out: Rows = [];
    for await (const page of pages(q, { deadlineMs })) out.push(...page);
    return out;
  }

  function whenIdle(timeoutMs = 5000): Promise<boolean> {
    if (queue.length === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        idleWaiters.delete(onIdle);
        resolve(false);
      }, timeoutMs);
      unref(timer);
      const onIdle = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      idleWaiters.add(onIdle);
      // 封未封的批，避免 whenIdle 等 250ms。
      for (const e of queue) if (e.kind === "chunks" && !e.sealed) seal(e);
      schedule();
    });
  }

  async function close(deadlineMs: number): Promise<void> {
    if (closed) return;
    const deadline = now() + deadlineMs;
    // 先让出一次（微任务：在当前宏任务的同步栈清空后才继续）：即使调用方处在某个 flush tick 的同步栈内，
    // 排空也只在该 tick 退出之后开始（安全评审 #2；runTick 另有重入守卫）。
    await Promise.resolve();
    if (closed) return;
    for (const e of queue) if (e.kind === "chunks" && !e.sealed) seal(e);
    while (queue.length > 0 && now() < deadline) {
      if (queue.some(hasLazy)) {
        if (materializeScheduled) clearImmediate(materializeScheduled);
        materializeTick();
      }
      if (backoffTimer) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Math.min(backoffMs || BACKOFF_MIN_MS, Math.max(1, deadline - now())));
          unref(t);
        });
        clearTimeout(backoffTimer ?? undefined);
        backoffTimer = null;
      }
      if (scheduled) {
        clearImmediate(scheduled);
        scheduled = null;
      }
      runTick();
      if (queue.length > 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    closed = true;
    if (scheduled) clearImmediate(scheduled);
    if (materializeScheduled) clearImmediate(materializeScheduled);
    materializeScheduled = null;
    if (backoffTimer) clearTimeout(backoffTimer);
    if (batchTimer) clearTimeout(batchTimer);
    scheduled = null;
    backoffTimer = null;
    batchTimer = null;
    for (const e of queue.splice(0)) drop(e, "dropped");
    queuedBytes = 0;
    settleIdle();
  }

  return {
    enqueue,
    patch,
    chunk,
    sealChunks,
    query,
    pages,
    whenIdle,
    close,
    stats: () => ({
      queued: queue.length,
      queuedBytes,
      droppedRows: stats.droppedRows,
      droppedByKind: { ...stats.droppedByKind },
      orphanOps: stats.orphanOps,
      busyBackoffs: stats.busyBackoffs,
      maxStmtMs: stats.maxStmtMs,
      maxTickMs: stats.maxTickMs,
      ticks: stats.ticks,
      writeErrors: stats.writeErrors,
      checkpoints: stats.checkpoints,
      maxCheckpointMs: stats.maxCheckpointMs,
      checkpointsDeferred: stats.checkpointsDeferred,
      walBytes,
      backoffMs,
    }),
  };
}
