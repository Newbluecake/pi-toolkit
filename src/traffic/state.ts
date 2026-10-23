/**
 * 全局共享状态（单进程内存态；录制开关不持久化，数据跨进程共享于同一 SQLite）。
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { GateSlot } from "./serialize.js";

export const RECORD_DIR = join(homedir(), ".pi", "agent", "records");
export const DB_PATH = join(RECORD_DIR, "traffic.db");
/** 0.2.0 之前的数据目录（命令与包由 dump 改名为 record 之前）；供一次性迁移使用。 */
export const LEGACY_RECORD_DIR = join(homedir(), ".pi", "agent", "dumps");
export const LEGACY_DB_PATH = join(LEGACY_RECORD_DIR, "traffic.db");
export const BASE_PORT = 4177;
export const MAX_PORT_TRIES = 20;
/** server 绑定地址：默认绑全网口，支持局域网访问 */
export const BIND_HOST = "0.0.0.0";

/** before_provider_request 创建的逻辑请求；无条件创建（录制只决定是否建 DB 行）。 */
export interface PendingRequest {
  rowId: number | null;
  sessionId: string;
  baseUrl: string | null;
  model: string | null;
  payloadLen: number;
  probe: string | null;
  /** v3 闸门关联字段；保留 optional 以兼容 v2 关联层。 */
  slot?: GateSlot | null;
  hookHeaders?: string | null;
  debugProbe?: string | null;
  createdAt: number;
  status: "waiting" | "sent" | "blocked" | "resolved";
  claimedBy: number[];
  streamCaptured: boolean;
}

/** 一次实际的 fetch 尝试；响应钩子只能通过该对象关联。 */
export interface Attempt {
  seq: number;
  url: string;
  method: string;
  origin: string;
  path: string;
  /** v3 闸门关联字段；保留 optional 以兼容 v2 拦截层。 */
  slot?: GateSlot | null;
  pending: PendingRequest | null;
  rowId: number | null;
  startedAt: number;
  settledAt?: number;
  outcome: "pending" | "response" | "failed" | "blocked";
  degraded?: boolean;
  status: number | null;
  respKey: string | null;
  afterConsumed: boolean;
  rewriteRuleIds: number[];
  /** 改写失败时用于写入阻断行的安全元数据。 */
  origPayload?: string | null;
  origHeaders?: Record<string, string>;
  applied?: import("./rewrite.js").ApplyResult | null;
}

export const state = {
  db: null as DatabaseSync | null,
  dbError: null as string | null,
  /** 测试可覆盖为临时路径（须在首次 ensureDb 前设置） */
  dbPath: DB_PATH,
  recording: false,
  server: null as Server | null,
  serverPort: null as number | null,
  /** 访问 token（每个进程随机生成）；回环访问豁免，局域网访问必须携带 */
  accessToken: null as string | null,
  sseClients: new Set<ServerResponse>(),
  currentTurn: 0,
  /** 本进程当前会话 id（session_start 时设置，供 /api/state 暴露给页面做“当前会话”定位） */
  currentSessionId: null as string | null,
  pendingRequests: [] as PendingRequest[],
  attempts: [] as Attempt[],
  attemptSeq: 0,
  unlinkedRewrites: 0,
  gateAcquired: 0,
  gateTimeouts: 0,
  gateNoFetch: 0,
  gateBypassed: 0,
  gateMaxQueueDepth: 0,
  correlationAssertFailures: 0,
  nullBaseUrlSkips: 0,
  /** null baseUrl 的一次性诊断提示。 */
  nullBaseUrlNotified: false,
  codexWsWarned: false,

  /** DB 基础设施错误只影响录制/改写持久化，不阻断 provider 请求。 */
  dbErrorNotified: false,
  /** 流式捕获已完成的 request_id（内存标记，供重放面板轮询判断收尾；进程重启后丢失，仅影响实时轮询） */
  streamDone: new Set<number>(),
  /** patch 前的原生 fetch（用于旁路抓取线级流式响应，并在 shutdown 时还原） */
  originalFetch: null as typeof globalThis.fetch | null,
};

/** 仅供测试：重置全部运行时状态（不关闭 db/server，调用方自行处理） */
export function resetState(): void {
  state.db = null;
  state.dbError = null;
  state.dbPath = DB_PATH;
  state.recording = false;
  state.server = null;
  state.serverPort = null;
  state.accessToken = null;
  state.sseClients.clear();
  state.currentTurn = 0;
  state.currentSessionId = null;
  state.pendingRequests = [];
  state.attempts = [];
  state.attemptSeq = 0;
  state.unlinkedRewrites = 0;
  state.gateAcquired = 0;
  state.gateTimeouts = 0;
  state.gateNoFetch = 0;
  state.gateBypassed = 0;
  state.gateMaxQueueDepth = 0;
  state.correlationAssertFailures = 0;
  state.nullBaseUrlSkips = 0;
  state.nullBaseUrlNotified = false;
  state.codexWsWarned = false;
  state.dbErrorNotified = false;
  state.streamDone.clear();
  state.originalFetch = null;
}

export type { IncomingMessage, Server, ServerResponse };
