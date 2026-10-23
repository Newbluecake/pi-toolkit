/**
 * TrafficEngine：owner 身份 + 单调纪元 + open/closing/closed 状态机（traffic-merge plan §5.2）。
 *
 * - 原各模块级变量（连接、录制开关、SSE 客户端、连接账本、取消域、jq 子进程集与 exit 监听、关联/闸门状态、
 *   计数器…）全部收入 engine；模块本身无可变状态。
 * - **容器创建**：只在首次显式 DB 访问 / `/record on` 时（`acquireEngine`）。
 * - **acquire**：`g.engine` 不存在 ⇒ 新建（`epoch = ++epochSeq`）；存在且 owner 相同且 open ⇒ 复用；
 *   owner 不同 ⇒ 陈旧（上一激活未正常 shutdown）：先 `close()` 再新建。
 * - **release**：只在 `g.engine === engine && engine.owner === owner` 时清空（旧激活迟到的 shutdown 不清新实例）。
 * - **close**：同步进入 `closing`：`recording=false`、退役 tap（撤销接纳：新钩子/新 fetch 立即透传）、
 *   中止取消域（重放/读流/后台捕获）、销毁连接（server.close + 逐个 destroy + closeAllConnections，SSE 客户端
 *   移出集合）、kill jq 子进程并移除 exit 监听；然后异步（有界 1s）关库，进入 `closed`。
 * - **T2b**：全局串行闸门（serialize.ts）与 holder 推断关联层（correlate 的 Correlator）退役，由票据台账
 *   （ticket.ts）取代；写走写后账本 `dbPort`（db-port.ts，每 tick 预算）。`gate` 只剩兼容桩 `gateStats()`
 *   （恒 inactive，供 server.ts 现有字段；T4 删除引用）。
 * - **异步续体固定 engine**：每个钩子、fetch、重放、流捕获在入口取一次 engine 引用并一路传参，禁止 await 之后
 *   再读 `g.engine`；落库一律经 `persist(engine, epoch, …)` 复查（persist.ts）。
 */
import { statSync } from "node:fs";
import type { Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { createCancelDomain, REPLAY_DEADLINES, type CancelDomain, type ReplayDeadlines } from "./cancel.js";
import { createCapture, type Capture } from "./capture.js";
import { ensureTrafficGlobal, nextEpoch, peekTrafficGlobal } from "./container.js";
import { createInThreadDbPort, type DbPort } from "./db-port.js";
import { defaultRecordPaths, ensureDb, loadSqlite as defaultLoadSqlite, type SqliteLoader } from "./db.js";
import { createJqRunner, type JqRunner } from "./jq.js";
import { serviceAllowed as computeServiceAllowed, type TrafficRole } from "./mode.js";
import { drainAllowed } from "./persist.js";
import { getEngineSettings, loadEnabledRules, type EngineSettings, type RewriteRule } from "./rewrite.js";
import type { TrafficServer } from "./server.js";
import { broadcast } from "./sse.js";
import { retireTap } from "./tap.js";
import { createTicketLedger, type RewriteBoundaryMarks, type TicketLedger } from "./ticket.js";

export type EngineState = "open" | "closing" | "closed";

/** 无快照 / 读失败时的引擎设置（与 rewrite.ts 的缺省值一致）。 */
export const FALLBACK_ENGINE_SETTINGS: EngineSettings = Object.freeze({
  jqPath: "",
  timeoutMs: 2_000,
  handoffMs: 10_000,
  retryGraceMs: 30_000,
  maxHoldMs: 120_000,
  queueWaitMs: 60_000,
});

/** 规则 / 设置的内存快照（provider 发送路径只读它，安全评审 #4）。 */
export interface RulesSnapshot {
  readonly rules: RewriteRule[];
  readonly settings: EngineSettings;
  /** 最近一次成功加载的时刻（Date.now）；null = 从未加载。 */
  readonly loadedAt: number | null;
}

/** 后台刷新间隔（unref 定时器；不在发送路径）。 */
export const RULES_REFRESH_MS = 1_000;

export type NotifyFn = (message: string, type?: "info" | "warning" | "error") => void;

export interface EngineCounters {
  /** persist 闸口拒绝的写（secure / 关闭 / 纪元不符）。 */
  droppedPersists: number;
  /** trampoline 重入守卫命中次数。 */
  tapReentry: number;
}

/** 闸门退役后的统计（r2 票据归属）：恒 inactive、全 0。仅为 server.ts 现有字段保留形状。 */
export interface RetiredGateStats {
  active: false;
  retired: true;
  queueDepth: 0;
  holderId: null;
  holderAgeMs: null;
  gateAcquired: 0;
  gateTimeouts: 0;
  gateNoFetch: 0;
  gateBypassed: 0;
  gateMaxQueueDepth: 0;
}

const RETIRED_GATE: RetiredGateStats = Object.freeze({
  active: false,
  retired: true,
  queueDepth: 0,
  holderId: null,
  holderAgeMs: null,
  gateAcquired: 0,
  gateTimeouts: 0,
  gateNoFetch: 0,
  gateBypassed: 0,
  gateMaxQueueDepth: 0,
}) as RetiredGateStats;

export interface TrafficEngine {
  // ---- 身份与状态机 ----
  readonly epoch: number;
  /** 主会话激活身份（T3 与 claim.token 为同一对象）。 */
  readonly owner: object;
  state: EngineState;
  /** 创建时一次性固定：主会话 ∧ mode ∈ {tui, rpc}（§4.1）。 */
  readonly serviceAllowed: boolean;
  readonly mode: string | undefined;

  // ---- DB ----
  /** 可写仅为测试便利（运行时只在创建时设定）。 */
  dbPath: string;
  readonly legacyDbPath: string | null;
  readonly loadSqlite: SqliteLoader;
  db: DatabaseSync | null;
  dbError: string | null;
  dbErrorNotified: boolean;

  // ---- 录制 / 服务 ----
  recording: boolean;
  server: Server | null;
  /** 启动中的 single-flight promise（server.ts）。 */
  serverStarting: Promise<number> | null;
  /** 每个曾创建、尚未关闭的 listener（含启动中 / 失败中的实例）；close 时全部关闭。 */
  readonly listeners: Set<Server>;
  serverPort: number | null;
  accessToken: string | null;
  sseClients: Set<ServerResponse>;
  /** 连接账本：每个 accepted socket（已 unref），close 时逐个 destroy。 */
  readonly connections: Set<Socket>;
  readonly replayDeadlines: ReplayDeadlines;
  /** 首个 GET / 懒加载并缓存（page.ts 的 buildPage）。 */
  page: { html: string; gzip: Buffer } | null;
  notify: NotifyFn | null;
  /** 网页服务实例（index.ts 在 /record on 时按需创建；仅 serviceAllowed 时）。 */
  web: TrafficServer | null;

  // ---- 归属（票据）----
  currentSessionId: string | null;
  /** 票据台账（每 engine 一份；engine 关闭即全部作废，§5.3 退役规则 ④）。 */
  readonly tickets: TicketLedger;
  /** 有启用规则但 provider baseUrl 未知 ⇒ 不改写（URL 边界无法校验）；计数 + 一次性提示。 */
  nullBaseUrlSkips: number;
  nullBaseUrlNotified: boolean;
  /** 白名单外 API 在规则启用时的一次性提示（R-b）。 */
  unsupportedApiNotified: boolean;
  /** 保留给 server.ts 的 `codex_ws_warning`（Codex 不在票据白名单时随上条一并置位）。 */
  codexWsWarned: boolean;
  /** 规则 / 设置内存快照（发送路径零 DB）。由 `refreshRules()` 更新。 */
  rulesSnapshot: RulesSnapshot;
  /** 快照刷新统计（/record status 可见）。 */
  readonly rulesRefresh: { refreshes: number; busySkips: number; errors: number; maxMs: number };
  /**
   * 同步重载规则 / 设置快照（命令路径、后台定时器、T4 规则 CRUD 之后调用；**不得**在 provider 发送路径调用）。
   * BUSY ⇒ 保留旧快照返回 false；其它错误 ⇒ 记 dbError、清空规则（改写失效、流量放行）返回 false。
   */
  refreshRules(): boolean;
  /** 启动后台刷新定时器（幂等；unref；close 时清除；只在 recording 时真正读库）。 */
  startRulesRefresh(): void;
  /** 改写暂停的解除边界序号（第三轮裁定 A；ticket.ts `rewriteSuspended`）。 */
  readonly rewriteMarks: RewriteBoundaryMarks;
  /**
   * 改写是否「上膛」：open ∧ 录制中 ∧ 快照里有启用规则。T5 的 warming 否决处理器消费此端口（裁定 A2：规则启用时
   * warming 本应被否决）；traffic 自己拿不到最终裁定，观测到 decision 一律暂停改写（fail closed）。
   */
  rewriteArmed(): boolean;
  /** secure 复查命中后已安排的延迟关闭（安全评审 #2：闸口不得同步重入账本）。 */
  secureClosePending: boolean;
  /** 会话最近一次请求被实际改写的时刻（T5 keepalive-port 的 vetoCapture 用）。 */
  readonly lastRewrittenAt: Map<string, number>;
  /** 流式捕获已完成的 request_id（重放面板轮询用）。 */
  streamDone: Set<number>;

  // ---- tap ----
  tapId: number | null;
  tapLost: boolean;
  tapLostReason: string | null;
  /** 活动 wrapper 见到过的票据（有界 FIFO，tap lost 判定用）。 */
  readonly tapSeen: Set<string>;

  readonly counters: EngineCounters;

  // ---- 组件 ----
  readonly cancel: CancelDomain;
  readonly jq: JqRunner;
  /** 写后账本 + 每 tick 预算（同线程实现；T2c 时可换 worker 实现，接口相同）。 */
  readonly dbPort: DbPort;
  /** 退役闸门的兼容桩。 */
  readonly gate: { gateStats(): RetiredGateStats };
  readonly capture: Capture;

  /** 同步进入 closing 并返回「关库完成」的 promise（有界 ~1s；幂等）。 */
  close(reason: string): Promise<void>;
}

export interface CreateEngineOptions {
  owner?: object;
  /** 缺省：从进程容器发号（会创建容器）。测试可显式给。 */
  epoch?: number;
  dbPath?: string;
  /** 旧库检测路径（null = 不检测）；缺省：dbPath 为默认路径时检测默认 dumps/。 */
  legacyDbPath?: string | null;
  loadSqlite?: SqliteLoader;
  role?: TrafficRole;
  /** ctx.mode（tui/rpc/json/print）。 */
  mode?: string;
  replayDeadlines?: Partial<ReplayDeadlines>;
  /** 关库上界（ms），缺省 1000。 */
  closeBoundMs?: number;
  /** 测试注入：票据台账时钟。 */
  ticketNow?: () => number;
  /** 测试注入：关库前 WAL 告警阈值（字节），缺省 CLOSE_WAL_WARN_BYTES。 */
  closeWalWarnBytes?: number;
  /** 测试注入：账本参数。 */
  dbPortOptions?: {
    tickBudgetMs?: number;
    maxEntries?: number;
    maxBytes?: number;
    chunkBatchMs?: number;
    checkpointBytes?: number;
    checkpointMaxBytes?: number;
  };
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

/** 关闭前 WAL 超过此大小 ⇒ console.warn 一行（关库的隐式 checkpoint 是已接受残留，第三轮裁定 B2）。 */
export const CLOSE_WAL_WARN_BYTES = 64 * 1024 * 1024;

/** 现场 stat `-wal` 文件大小：不存在 ⇒ 0；其它失败 ⇒ null（调用方按「无法证明」处理）。 */
export function walFileBytes(dbPath: string): number | null {
  try {
    return statSync(`${dbPath}-wal`).size;
  } catch (err) {
    return (err as { code?: string } | null)?.code === "ENOENT" ? 0 : null;
  }
}

function isBusyError(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string } | null;
  return !!e && (e.errcode === 5 || e.errcode === 6 || /database is locked/i.test(String(e.message ?? "")));
}

/** 创建一个**不注册到容器**的 engine（测试 / acquireEngine 内部使用）。 */
export function createTrafficEngine(opts: CreateEngineOptions = {}): TrafficEngine {
  const defaults = defaultRecordPaths();
  const dbPath = opts.dbPath ?? defaults.dbPath;
  const legacyDbPath =
    opts.legacyDbPath === undefined ? (dbPath === defaults.dbPath ? defaults.legacyDbPath : null) : opts.legacyDbPath;
  const role: TrafficRole = opts.role ?? "host";
  const closeBoundMs = opts.closeBoundMs ?? 1000;
  let closing: Promise<void> | null = null;
  let rulesTimer: ReturnType<typeof setInterval> | null = null;

  const engine = {
    epoch: opts.epoch ?? nextEpoch(),
    owner: opts.owner ?? {},
    state: "open" as EngineState,
    serviceAllowed: computeServiceAllowed(role, opts.mode),
    mode: opts.mode,
    dbPath,
    legacyDbPath,
    loadSqlite: opts.loadSqlite ?? defaultLoadSqlite,
    db: null,
    dbError: null,
    dbErrorNotified: false,
    recording: false,
    server: null,
    serverStarting: null,
    listeners: new Set<Server>(),
    serverPort: null,
    accessToken: null,
    sseClients: new Set<ServerResponse>(),
    connections: new Set<Socket>(),
    replayDeadlines: { ...REPLAY_DEADLINES, ...(opts.replayDeadlines ?? {}) },
    page: null,
    notify: null,
    web: null,
    currentSessionId: null,
    tickets: createTicketLedger(opts.ticketNow ? { now: opts.ticketNow } : {}),
    nullBaseUrlSkips: 0,
    nullBaseUrlNotified: false,
    unsupportedApiNotified: false,
    codexWsWarned: false,
    rulesSnapshot: { rules: [], settings: FALLBACK_ENGINE_SETTINGS, loadedAt: null } as RulesSnapshot,
    rulesRefresh: { refreshes: 0, busySkips: 0, errors: 0, maxMs: 0 },
    secureClosePending: false,
    rewriteMarks: { resumeSeq: 0, zeroSeq: 0 },
    lastRewrittenAt: new Map<string, number>(),
    streamDone: new Set<number>(),
    tapId: null,
    tapLost: false,
    tapLostReason: null,
    tapSeen: new Set<string>(),
    counters: { droppedPersists: 0, tapReentry: 0 },
    cancel: createCancelDomain(),
    jq: createJqRunner(),
    gate: { gateStats: () => RETIRED_GATE },
  } as unknown as Omit<
    TrafficEngine,
    "dbPort" | "capture" | "close" | "refreshRules" | "startRulesRefresh" | "rewriteArmed"
  > & {
    rewriteArmed: () => boolean;
    dbPort: DbPort;
    capture: Capture;
    close: (reason: string) => Promise<void>;
    refreshRules: () => boolean;
    startRulesRefresh: () => void;
  };
  const full = engine as TrafficEngine;
  engine.dbPort = createInThreadDbPort({
    // 运行中按需打开；closing/closed 只用已打开的连接（绝不在关闭后重开库）。
    getDb: () => (full.state === "open" ? ensureDb(full) : full.db),
    gate: (epoch) => drainAllowed(full, epoch),
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!full.dbError) full.dbError = message;
      if (!full.dbErrorNotified) {
        full.dbErrorNotified = true;
        broadcast(full, { type: "record_warn", message: `数据库错误，部分录制写入失败: ${message}` });
      }
    },
    notify: (message) => full.notify?.(message, "warning"),
    // 运行时 checkpoint 只在现场 stat 的 WAL ≤ 上限时执行（第三轮裁定 B1）。
    walSize: () => walFileBytes(full.dbPath),
    ...(opts.dbPortOptions ?? {}),
  });
  engine.capture = createCapture(full);
  engine.refreshRules = (): boolean => {
    if (full.state !== "open") return false;
    const t0 = performance.now();
    try {
      const db = ensureDb(full);
      const rules = loadEnabledRules(db);
      const settings = getEngineSettings(db);
      full.rulesSnapshot = { rules, settings, loadedAt: Date.now() };
      full.rulesRefresh.refreshes++;
      // 「启用规则为零」是改写暂停的可验证解除边界之一（只计成功读到的零，读失败不算）。
      if (rules.length === 0) full.rewriteMarks.zeroSeq++;
      return true;
    } catch (err) {
      if (isBusyError(err)) {
        full.rulesRefresh.busySkips++;
        return false;
      }
      full.rulesRefresh.errors++;
      const message = err instanceof Error ? err.message : String(err);
      if (!full.dbError) full.dbError = message;
      full.rulesSnapshot = { rules: [], settings: FALLBACK_ENGINE_SETTINGS, loadedAt: full.rulesSnapshot.loadedAt };
      return false;
    } finally {
      const ms = performance.now() - t0;
      if (ms > full.rulesRefresh.maxMs) full.rulesRefresh.maxMs = ms;
    }
  };
  engine.rewriteArmed = (): boolean => full.state === "open" && full.recording && full.rulesSnapshot.rules.length > 0;
  engine.startRulesRefresh = (): void => {
    if (rulesTimer || full.state !== "open") return;
    rulesTimer = setInterval(() => {
      if (full.state !== "open") return;
      if (full.recording) full.refreshRules();
    }, RULES_REFRESH_MS);
    unrefTimer(rulesTimer);
  };
  engine.close = (reason: string): Promise<void> => {
    if (closing) return closing;
    // ---- 同步段：撤销接纳 ----
    full.state = "closing";
    full.recording = false;
    if (rulesTimer) clearInterval(rulesTimer);
    rulesTimer = null;
    retireTap(full);
    full.cancel.abortAll(reason);
    full.tickets.retireAll();
    for (const res of full.sseClients) {
      try {
        res.end();
      } catch {}
    }
    full.sseClients.clear();
    // 关闭**所有**曾监听的 listener（不只 full.server：并发启动 / 启动中的实例同样要释放端口）。
    const servers = new Set<Server>(full.listeners);
    if (full.server) servers.add(full.server);
    full.server = null;
    full.serverPort = null;
    full.serverStarting = null;
    full.accessToken = null;
    const serverClosed = Promise.all(
      [...servers].map(
        (server) =>
          new Promise<void>((resolve) => {
            // close 回调在真正释放端口后触发（未在监听的实例回调也会带错误立即触发）。
            try {
              server.close(() => resolve());
            } catch {
              resolve();
            }
          }),
      ),
    ).then(() => undefined);
    for (const socket of full.connections) {
      try {
        socket.destroy();
      } catch {}
    }
    full.connections.clear();
    for (const server of servers) {
      try {
        (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      } catch {}
    }
    // 账本同步清空：全部已进入关闭（端口在 serverClosed 之后真正释放）。
    full.listeners.clear();
    full.jq.dispose();
    // ---- 异步段：有界排空账本（关闭前已接纳的条目）+ 有界关库 ----
    const t0 = Date.now();
    closing = (async () => {
      try {
        await full.dbPort.close(closeBoundMs);
      } catch {}
      const remaining = Math.max(0, closeBoundMs - (Date.now() - t0));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        unrefTimer(timer);
        void serverClosed.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (full.db) {
        // 最后一个连接关库时 SQLite 同步做全量 checkpoint（已接受残留：shutdown / reload，不在发送路径）。大 WAL 先告知。
        const wal = walFileBytes(full.dbPath);
        if (wal !== null && wal > (opts.closeWalWarnBytes ?? CLOSE_WAL_WARN_BYTES))
          console.warn(
            `[pi-subagent] traffic: 关闭录制库时 WAL 为 ${(wal / 1024 / 1024).toFixed(1)} MiB，SQLite 关库的 checkpoint 可能短暂阻塞（${full.dbPath}-wal）`,
          );
      }
      try {
        full.db?.close();
      } catch {}
      full.db = null;
      full.state = "closed";
    })();
    return closing;
  };
  return full;
}

/** 读主会话 engine（不创建容器）。子会话钩子与只读查询用。 */
export function peekEngine(): TrafficEngine | undefined {
  return peekTrafficGlobal()?.engine;
}

/**
 * 认领进程级 engine（§5.2）。同 owner 且 open ⇒ 复用；不同 owner ⇒ 关闭陈旧者后新建。
 */
export function acquireEngine(owner: object, opts: Omit<CreateEngineOptions, "owner" | "epoch"> = {}): TrafficEngine {
  const g = ensureTrafficGlobal();
  const current = g.engine;
  if (current && current.owner === owner && current.state === "open") return current;
  if (current) {
    void current.close(current.owner === owner ? "reopen" : "stale");
    delete g.engine;
  }
  const engine = createTrafficEngine({ ...opts, owner });
  g.engine = engine;
  return engine;
}

/** 身份校验释放：只在 `g.engine === engine && engine.owner === owner` 时清空。返回是否清空。 */
export function releaseEngine(owner: object, engine: TrafficEngine): boolean {
  const g = peekTrafficGlobal();
  if (!g || g.engine !== engine || engine.owner !== owner) return false;
  delete g.engine;
  return true;
}
