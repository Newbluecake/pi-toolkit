/**
 * 通用 JSON-RPC 客户端（external-agent plan §4.2 / arch §4.4）。pi-free，provider 无关：信封由 provider 注入。
 * - 请求 id：字符串、单调 "1","2",…；每请求独立计时器（clock，生产为 unref 的 systemClock）。
 * - 行帧：按 \n 切，单行上限（默认 8 MiB）超限 ⇒ 致命；非 JSON 行忽略并计数，连续 ≥20 / 累计 ≥200 ⇒ 致命。
 * - 入站：响应 / 反向请求（method+id 或 type:"request"）/ 通知；`id:null` 的错误响应 ⇒ 致命（信封被拒）。
 * - 反向请求同步应答，绝不悬挂。
 * - 出站帧只含标准 JSON-RPC 字段（jsonrpc/id/method/params|result/error）；provider 专有的信封字段（如 droid 的
 *   `type:"request"|"response"` 与版本号）一律由 `envelope.decorate` 注入，框架不写。
 */
import { StringDecoder } from "node:string_decoder";
import { ClassifiedError } from "../core/errors.js";
import type { TimerHandle } from "../core/clock.js";
import type { CreateJsonRpcClient, JsonRpcClient, RequestReply } from "./types.js";

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const NON_JSON_CONSECUTIVE_FATAL = 20;
const NON_JSON_TOTAL_FATAL = 200;

function internal(message: string): ClassifiedError {
  return new ClassifiedError({ kind: "internal", message, retryable: false });
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  timer: TimerHandle;
  method: string;
}

export const createJsonRpcClient: CreateJsonRpcClient = (o): JsonRpcClient => {
  const maxLine = o.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const decoder = new StringDecoder("utf8");
  const pending = new Map<string, Pending>();
  const driftSeen = new Set<string>();
  let seq = 0;
  let buf = "";
  let bufBytes = 0;
  let consecutiveNonJson = 0;
  let nonJsonLines = 0;
  let lateResponses = 0;
  let fatal = false;
  let failure: ClassifiedError | undefined;

  function failAll(e: ClassifiedError): void {
    failure ??= e;
    const all = [...pending.values()];
    pending.clear();
    for (const p of all) {
      o.clock.clearTimer(p.timer);
      p.reject(e);
    }
  }

  function die(e: ClassifiedError): void {
    if (fatal) return;
    fatal = true;
    buf = "";
    bufBytes = 0;
    failAll(e);
    try {
      o.onProtocolError(e);
    } catch {
      /* provider handler must not break the client */
    }
  }

  function send(msg: Record<string, unknown>): void {
    o.write(JSON.stringify(o.envelope.decorate(msg)) + "\n");
  }

  function respond(id: string | number, reply: RequestReply): void {
    const base: Record<string, unknown> = { jsonrpc: "2.0", id };
    try {
      send("result" in reply ? { ...base, result: reply.result ?? null } : { ...base, error: reply.error });
    } catch (e) {
      die(internal(`failed to answer reverse request ${String(id)}: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  function handleRequest(method: string, id: string | number, params: unknown): void {
    let reply: RequestReply;
    try {
      reply = o.onRequest(method, String(id), params);
    } catch (e) {
      respond(id, { error: { code: -32603, message: "internal error in host request handler" } });
      die(internal(`reverse request handler threw for ${method}: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    respond(id, reply);
  }

  function handleMessage(msg: Record<string, unknown>): void {
    // 漂移检测：每个入站对象都带对端版本；同一 (expected, actual) 只上报一次。
    try {
      const v = o.envelope.check(msg);
      if (!v.ok) {
        const key = `${v.drift.expected}|${v.drift.actual}`;
        if (!driftSeen.has(key)) {
          driftSeen.add(key);
          o.onDrift(v.drift);
        }
      }
    } catch {
      /* envelope/drift handler bugs must not poison framing */
    }
    if (fatal) return;

    const id = msg.id;
    const method = msg.method;
    if (id === null && "error" in msg) {
      const err = msg.error as { code?: unknown; message?: unknown } | undefined;
      die(
        internal(
          `host message rejected by peer (id:null error ${String(err?.code)}: ${String(err?.message)}) — envelope/protocol mismatch`,
        ),
      );
      return;
    }
    const hasId = typeof id === "string" || typeof id === "number";
    if (typeof method === "string") {
      if (hasId) handleRequest(method, id, msg.params);
      else {
        try {
          o.onNotification(method, msg.params);
        } catch (e) {
          die(internal(`notification handler threw for ${method}: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
      return;
    }
    if (msg.type === "request" && hasId) {
      handleRequest("", id, msg.params);
      return;
    }
    if (hasId) {
      const p = pending.get(String(id));
      if (p === undefined) {
        lateResponses++;
        return;
      }
      pending.delete(String(id));
      o.clock.clearTimer(p.timer);
      const err = msg.error as { code?: unknown; message?: unknown } | undefined;
      if (err !== undefined && err !== null && typeof err === "object") {
        const e = internal(`JSON-RPC error ${String(err.code)} on ${p.method}: ${String(err.message)}`);
        Object.assign(e, { rpcCode: err.code });
        p.reject(e);
      } else p.resolve(msg.result);
      return;
    }
    // 既非响应也非请求/通知的对象：计作非协议行（不致命计数，仅忽略）。
    nonJsonLines++;
  }

  function handleLine(line: string): void {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      nonJsonLines++;
      consecutiveNonJson++;
      if (consecutiveNonJson >= NON_JSON_CONSECUTIVE_FATAL || nonJsonLines >= NON_JSON_TOTAL_FATAL) {
        die(internal(`stdout polluted: ${nonJsonLines} non-JSON lines (${consecutiveNonJson} consecutive)`));
      }
      return;
    }
    consecutiveNonJson = 0;
    handleMessage(parsed as Record<string, unknown>);
  }

  return {
    feed(chunk) {
      if (fatal) return;
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      let start = 0;
      for (;;) {
        const nl = text.indexOf("\n", start);
        if (nl < 0) {
          const rest = text.slice(start);
          buf += rest;
          bufBytes += Buffer.byteLength(rest);
          if (bufBytes > maxLine) die(internal(`stdout line exceeds ${maxLine} bytes`));
          return;
        }
        const piece = text.slice(start, nl);
        const line = buf + piece;
        if (bufBytes + Buffer.byteLength(piece) > maxLine) {
          die(internal(`stdout line exceeds ${maxLine} bytes`));
          return;
        }
        buf = "";
        bufBytes = 0;
        start = nl + 1;
        handleLine(line);
        if (fatal) return;
      }
    },
    request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
      if (failure !== undefined) return Promise.reject(failure);
      const id = String(++seq);
      return new Promise<T>((resolve, reject) => {
        const timer = o.clock.setTimer(timeoutMs, () => {
          if (pending.delete(id)) reject(internal(`JSON-RPC request ${method} timed out after ${timeoutMs}ms`));
        });
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
        try {
          send({ jsonrpc: "2.0", id, method, params });
        } catch (e) {
          pending.delete(id);
          o.clock.clearTimer(timer);
          reject(
            e instanceof ClassifiedError
              ? e
              : internal(`failed to write ${method}: ${e instanceof Error ? e.message : String(e)}`),
          );
        }
      });
    },
    failAll,
    stats: () => ({ lateResponses, nonJsonLines }),
  };
};
