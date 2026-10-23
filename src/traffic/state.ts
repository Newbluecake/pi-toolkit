/**
 * traffic 共享类型与常量（T2a：模块无可变状态；运行时状态全部归 engine，见 engine.ts）。
 * 数据库路径算法见 db.ts 的 defaultRecordPaths()（调用时计算，固定 homedir()/.pi/agent/records）。
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { GateSlot } from "./serialize.js";

export const BASE_PORT = 4177;
export const MAX_PORT_TRIES = 20;
/** server 绑定地址：默认绑全网口，支持局域网访问（T4 改为 traffic.web.host，默认 127.0.0.1）。 */
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

export type { IncomingMessage, Server, ServerResponse };
