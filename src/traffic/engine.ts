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
 * - **异步续体固定 engine**：每个钩子、fetch、重放、流捕获在入口取一次 engine 引用并一路传参，禁止 await 之后
 *   再读 `g.engine`；落库一律经 `persist(engine, epoch, …)` 复查（persist.ts）。
 */
import type { Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { createCancelDomain, REPLAY_DEADLINES, type CancelDomain, type ReplayDeadlines } from "./cancel.js";
import { createCapture, type Capture } from "./capture.js";
import { ensureTrafficGlobal, nextEpoch, peekTrafficGlobal } from "./container.js";
import { createCorrelator, type Correlator } from "./correlate.js";
import { defaultRecordPaths, loadSqlite as defaultLoadSqlite, type SqliteLoader } from "./db.js";
import { createJqRunner, type JqRunner } from "./jq.js";
import { serviceAllowed as computeServiceAllowed, type TrafficRole } from "./mode.js";
import { createGate, type Gate } from "./serialize.js";
import type { Attempt, PendingRequest } from "./state.js";
import type { TrafficServer } from "./server.js";
import { retireTap } from "./tap.js";

export type EngineState = "open" | "closing" | "closed";

export type NotifyFn = (message: string, type?: "info" | "warning" | "error") => void;

export interface EngineCounters {
  /** persist 闸口拒绝的写（secure / 关闭 / 纪元不符）。 */
  droppedPersists: number;
  /** trampoline 重入守卫命中次数。 */
  tapReentry: number;
}

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

  // ---- 关联 / 闸门（T2b 以票据取代）----
  currentSessionId: string | null;
  pendingRequests: PendingRequest[];
  attempts: Attempt[];
  attemptSeq: number;
  unlinkedRewrites: number;
  gateAcquired: number;
  gateTimeouts: number;
  gateNoFetch: number;
  gateBypassed: number;
  gateMaxQueueDepth: number;
  correlationAssertFailures: number;
  nullBaseUrlSkips: number;
  nullBaseUrlNotified: boolean;
  codexWsWarned: boolean;
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
  readonly gate: Gate;
  readonly corr: Correlator;
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
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
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
    pendingRequests: [],
    attempts: [],
    attemptSeq: 0,
    unlinkedRewrites: 0,
    gateAcquired: 0,
    gateTimeouts: 0,
    gateNoFetch: 0,
    gateBypassed: 0,
    gateMaxQueueDepth: 0,
    correlationAssertFailures: 0,
    nullBaseUrlSkips: 0,
    nullBaseUrlNotified: false,
    codexWsWarned: false,
    streamDone: new Set<number>(),
    tapId: null,
    tapLost: false,
    tapLostReason: null,
    tapSeen: new Set<string>(),
    counters: { droppedPersists: 0, tapReentry: 0 },
    cancel: createCancelDomain(),
    jq: createJqRunner(),
  } as unknown as Omit<TrafficEngine, "gate" | "corr" | "capture" | "close"> & {
    gate: Gate;
    corr: Correlator;
    capture: Capture;
    close: (reason: string) => Promise<void>;
  };
  const full = engine as TrafficEngine;
  engine.gate = createGate(full);
  engine.corr = createCorrelator(full, engine.gate);
  engine.capture = createCapture(full);
  engine.close = (reason: string): Promise<void> => {
    if (closing) return closing;
    // ---- 同步段：撤销接纳 ----
    full.state = "closing";
    full.recording = false;
    retireTap(full);
    full.cancel.abortAll(reason);
    try {
      full.gate.drainGate("drain");
    } catch {}
    full.corr.resetCorrelation();
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
    // ---- 异步段：有界关库 ----
    closing = (async () => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, closeBoundMs);
        unrefTimer(timer);
        void serverClosed.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
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
