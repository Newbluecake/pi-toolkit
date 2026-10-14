/**
 * droid JSON-RPC 信封（plan §4.2）：出站装饰 + 入站版本比对。
 *
 * S6 实测：droid 对请求侧版本不校验（1.200.0/9.9.9 均被接受），但每条入站消息都恒带
 * droid 自身的 factoryProtocolVersion/factoryApiVersion —— 入站比对是有效的漂移检测点
 * （目录探测 init / 每 run init / 运行中任一入站消息）。
 */
import type { Envelope, EnvelopeVerdict } from "../types.js";
import { DROID_API_VERSION, DROID_PROTOCOL_VERSION } from "./protocol.js";

export interface DroidEnvelope extends Envelope {
  /** 最近一条入站消息的 factoryProtocolVersion（探测/诊断用；从未收到 ⇒ undefined）。 */
  lastSeenProtocolVersion(): string | undefined;
  /** 最近一条入站消息的 factoryApiVersion。 */
  lastSeenApiVersion(): string | undefined;
}

export function createDroidEnvelope(): DroidEnvelope {
  let lastProtocol: string | undefined;
  let lastApi: string | undefined;
  return {
    decorate(msg) {
      // type 是 droid 专有信封字段（框架 jsonrpc 不写）：已有字符串就保留；否则含
      // result/error 键的是对反向请求的响应帧，其余为请求帧。
      const type = typeof msg.type === "string" ? msg.type : "result" in msg || "error" in msg ? "response" : "request";
      return {
        ...msg,
        type,
        factoryApiVersion: DROID_API_VERSION,
        factoryProtocolVersion: DROID_PROTOCOL_VERSION,
      };
    },
    check(msg): EnvelopeVerdict {
      // §4.2④：`id:null -32700` 是信封被拒（缺字段/格式错），不是版本漂移信号——
      // 不归 drift（避免 strict 把它错报成 config 漂移）；客户端把它当协议致命 internal。
      const err = msg.error;
      if (
        msg.id === null &&
        err !== null &&
        typeof err === "object" &&
        (err as Record<string, unknown>).code === -32700
      )
        return { ok: true };
      const protocol = typeof msg.factoryProtocolVersion === "string" ? msg.factoryProtocolVersion : undefined;
      const api = typeof msg.factoryApiVersion === "string" ? msg.factoryApiVersion : undefined;
      if (protocol !== undefined) lastProtocol = protocol;
      if (api !== undefined) lastApi = api;
      if (protocol !== DROID_PROTOCOL_VERSION)
        return { ok: false, drift: { expected: DROID_PROTOCOL_VERSION, actual: protocol ?? "<missing>" } };
      if (api !== DROID_API_VERSION)
        return { ok: false, drift: { expected: DROID_API_VERSION, actual: api ?? "<missing>" } };
      return { ok: true };
    },
    lastSeenProtocolVersion: () => lastProtocol,
    lastSeenApiVersion: () => lastApi,
  };
}
