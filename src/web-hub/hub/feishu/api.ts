/**
 * Typed thin wrappers over exactly the Feishu calls the bot plan needs (§2.1 bootstrap, §3 send/reply/
 * patch/reactions/uploads/download/botInfo). No business logic: no retries beyond the one mandatory
 * token-invalid retry, no chunking, no routing, no persistence. Request shapes are the ones verified live by
 * the F-probe (`scripts/dev/feishu-probe/steps.ts`, `docs/dev/feishu-bot/probe-results.md`).
 *
 * Failure model (see `http.ts`): every call returns `{ok:true,data} | FeishuFailure`, never throws. A failure
 * carries `effect` (`none` ⇒ provably not sent; `unknown` ⇒ a send may only be retried with the SAME `uuid`),
 * `retryable`, and — for capability probing (§4) — `capabilityDenied` when the code is in
 * `FEISHU_CAPABILITY_DENIED_CODES`. Local argument validation failures are `bad-request:<field>` (effect none).
 *
 * Token handling: every authenticated call resolves the token through `TokenManager.get()`; a
 * `99991663/99991664` reply invalidates exactly that token and the call is repeated ONCE with a fresh one
 * (safe: the platform rejected the token before acting; sends stay idempotent through their `uuid`).
 */

import {
  FEISHU_BOOTSTRAP,
  FEISHU_CAPABILITY_DENIED_CODES,
  FEISHU_FILE_LIMITS,
  FEISHU_OPEN_ID_RE,
  FEISHU_REPLY_LIMITS,
  FEISHU_TOKEN_INVALID_CODES,
  classifyBootstrapCode,
  clampClientConfig,
  isAllowedWsUrl,
} from "../../protocol/feishu.js";
import type { FeishuClientConfig } from "../../protocol/feishu.js";
import { makeFailure } from "./http.js";
import type { FeishuFailure, FeishuHttp, FeishuJson, FeishuRequest, FeishuResult, FeishuStreamInfo } from "./http.js";
import type { TokenManager } from "./token.js";

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ReceiveIdType = "chat_id" | "open_id";
export const FEISHU_SEND_MSG_TYPES = ["text", "post", "interactive", "image", "file"] as const;
export type FeishuMsgType = (typeof FEISHU_SEND_MSG_TYPES)[number];
export const FEISHU_UPLOAD_FILE_TYPES = ["opus", "mp4", "pdf", "doc", "xls", "ppt", "stream"] as const;
export type FeishuUploadFileType = (typeof FEISHU_UPLOAD_FILE_TYPES)[number];

export interface SendParams extends CallOptions {
  receiveIdType: ReceiveIdType;
  receiveId: string;
  msgType: FeishuMsgType;
  /** The already-serialized JSON content string (the platform's `content` field). */
  content: string;
  /** Idempotency key (≤50 chars `[A-Za-z0-9_-]`): REQUIRED — the same uuid on every retry of one logical send. */
  uuid: string;
}

export interface ReplyParams extends CallOptions {
  messageId: string;
  msgType: FeishuMsgType;
  content: string;
  uuid: string;
  /** `reply_in_thread:true` — on a normal-group message the response carries the new `thread_id` (probe V8). */
  replyInThread?: boolean;
}

export interface SentMessage {
  messageId: string;
  chatId?: string;
  threadId?: string;
  rootId?: string;
  parentId?: string;
}

export interface PatchCardParams extends CallOptions {
  messageId: string;
  /** The serialized card JSON (keep `config.update_multi:true` for multi-viewer cards, V5). */
  card: string;
}

export interface ReactionParams extends CallOptions {
  messageId: string;
  /** e.g. `Typing` (V9). */
  emojiType: string;
}

export interface DeleteReactionParams extends CallOptions {
  messageId: string;
  reactionId: string;
}

export interface UploadImageParams extends CallOptions {
  bytes: Uint8Array | Blob;
  fileName?: string;
}

export interface UploadFileParams extends CallOptions {
  bytes: Uint8Array | Blob;
  fileName: string;
  /** default `stream` (probe P6) */
  fileType?: FeishuUploadFileType;
}

export interface DownloadResourceParams extends CallOptions {
  /** The message that carried the resource (the platform only serves resources through their message). */
  messageId: string;
  fileKey: string;
  type: "image" | "file";
  /** Hard byte cap (also checked against Content-Length before reading). */
  maxBytes: number;
  /** Receives chunks in order; awaiting provides backpressure; a throw aborts (`aborted`/`sink-failed`). */
  sink: (chunk: Uint8Array) => void | Promise<void>;
}

export interface BotInfo {
  openId: string;
  appName?: string;
}

export interface BootstrapParams extends CallOptions {
  appId: string;
  appSecret: string;
}

/** What the connector needs from a successful bootstrap. `url` is single-use and a credential: never log it. */
export interface BootstrapEndpoint {
  url: string;
  serviceId: number;
  deviceId: string;
  /** server ClientConfig, clamped (§2.4) */
  config: FeishuClientConfig;
}

export type BootstrapFailureClass =
  /** §2.1 `1`/`1000040343`, transport/timeout/5xx/any HTTP status without a code, malformed endpoint ids */
  | "retry"
  /** §2.1 `514`/`403`/`10003`/`10014`/`1000040345`/any other non-zero code (V11) */
  | "auth_failed"
  /** §2.1 `1000040350` */
  | "conn_limit"
  /** §2.2 destination allowlist refusal (base or returned WS URL) — never dial; `degraded` */
  | "refused"
  /** caller `signal` fired */
  | "aborted";

export interface BootstrapFailure {
  ok: false;
  class: BootstrapFailureClass;
  /** locally generated (`api-code-N`, `http-N`, `timeout`, `ws-url-not-allowed`, …) */
  reason: string;
  code?: number;
  /** sanitized platform message, surfaced for `auth_failed` */
  msg?: string;
  failure: FeishuFailure;
}
export type BootstrapResult = { ok: true; data: BootstrapEndpoint } | BootstrapFailure;

export interface FeishuApi {
  /** §2.1 `POST /callback/ws/endpoint` (no token; the app secret goes in the body only). */
  bootstrap(params: BootstrapParams): Promise<BootstrapResult>;
  /** `POST /im/v1/messages` (text/post/interactive/image/file). */
  send(params: SendParams): Promise<FeishuResult<SentMessage>>;
  /** `POST /im/v1/messages/:id/reply` (+`reply_in_thread`). */
  reply(params: ReplyParams): Promise<FeishuResult<SentMessage>>;
  /** `PATCH /im/v1/messages/:id` — card update. */
  patchCard(params: PatchCardParams): Promise<FeishuResult<void>>;
  /** `POST /im/v1/messages/:id/reactions` ⇒ reaction id. */
  addReaction(params: ReactionParams): Promise<FeishuResult<{ reactionId: string }>>;
  /** `DELETE /im/v1/messages/:id/reactions/:reactionId`. */
  deleteReaction(params: DeleteReactionParams): Promise<FeishuResult<void>>;
  /** `POST /im/v1/images` (multipart, `image_type=message`) ⇒ image_key. */
  uploadImage(params: UploadImageParams): Promise<FeishuResult<{ imageKey: string }>>;
  /** `POST /im/v1/files` (multipart) ⇒ file_key. */
  uploadFile(params: UploadFileParams): Promise<FeishuResult<{ fileKey: string }>>;
  /** `GET /im/v1/messages/:id/resources/:key?type=` streamed through `sink` under a byte cap. */
  downloadResource(params: DownloadResourceParams): Promise<FeishuResult<FeishuStreamInfo>>;
  /** `GET /bot/v3/info` ⇒ the bot's own open_id (response has a top-level `bot`, not `data.bot`). */
  botInfo(params?: CallOptions): Promise<FeishuResult<BotInfo>>;
}

export interface FeishuApiDeps {
  http: FeishuHttp;
  token: TokenManager;
}

/** Upload default deadline: multi-MB multipart is not an 8 s call (F2 decision; same as the inbound per-file budget). */
export const FEISHU_UPLOAD_TIMEOUT_MS = FEISHU_FILE_LIMITS.inboundTimeoutMs;

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

const UUID_RE = /^[A-Za-z0-9_-]{1,50}$/;
const EMOJI_RE = /^[A-Za-z0-9_]{1,64}$/;
const MAX_FILE_NAME_BYTES = 255;

const bad = (field: string): FeishuFailure => makeFailure("bad-request", `bad-request:${field}`);

/** An opaque platform id used as a URL path segment: bounded, no separators/controls (it is also encoded). */
function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    value !== "." &&
    value !== ".." &&
    // eslint-disable-next-line no-control-regex
    !/[\s/\\?#%\u0000-\u001f\u007f]/.test(value)
  );
}

function validFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).length <= MAX_FILE_NAME_BYTES &&
    // eslint-disable-next-line no-control-regex
    !/[/\\\u0000-\u001f\u007f]/.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

function asBlob(bytes: Uint8Array | Blob): Blob {
  return bytes instanceof Blob ? bytes : new Blob([bytes as unknown as ArrayBuffer]);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export function createFeishuApi(deps: FeishuApiDeps): FeishuApi {
  const { http, token } = deps;

  const decorate = (failure: FeishuFailure): FeishuFailure => {
    if (failure.code !== undefined && FEISHU_CAPABILITY_DENIED_CODES.includes(failure.code)) {
      failure.capabilityDenied = true;
    }
    return failure;
  };

  /** Token → call → (token-invalid ⇒ invalidate that token, ONE retry) → capability decoration. */
  async function authed<T>(
    opts: CallOptions | undefined,
    call: (bearer: string) => Promise<FeishuResult<T>>,
  ): Promise<FeishuResult<T>> {
    for (let attempt = 0; ; attempt++) {
      const t = await token.get(opts?.signal !== undefined ? { signal: opts.signal } : undefined);
      if (!t.ok) return t;
      const r = await call(t.data.token);
      if (r.ok) return r;
      if (attempt === 0 && r.kind === "api" && r.code !== undefined && FEISHU_TOKEN_INVALID_CODES.includes(r.code)) {
        token.invalidate(t.data.token);
        continue;
      }
      return decorate(r);
    }
  }

  const common = (opts: CallOptions | undefined): Pick<FeishuRequest, "signal" | "timeoutMs"> => ({
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  const sentFrom = (r: FeishuJson): FeishuResult<SentMessage> => {
    const d = r.data;
    const messageId = str(d?.["message_id"]);
    // 2xx + code 0 but no message id: the message may well exist ⇒ effect "unknown" (protocol kind)
    if (d === undefined || messageId === undefined) {
      return makeFailure("protocol", "protocol:missing-message-id", { status: r.status });
    }
    const out: SentMessage = { messageId };
    const chatId = str(d["chat_id"]);
    const threadId = str(d["thread_id"]);
    const rootId = str(d["root_id"]);
    const parentId = str(d["parent_id"]);
    if (chatId !== undefined) out.chatId = chatId;
    if (threadId !== undefined) out.threadId = threadId;
    if (rootId !== undefined) out.rootId = rootId;
    if (parentId !== undefined) out.parentId = parentId;
    return { ok: true, data: out };
  };

  const checkContent = (msgType: unknown, content: unknown, uuid: unknown): FeishuFailure | undefined => {
    if (typeof msgType !== "string" || !(FEISHU_SEND_MSG_TYPES as readonly string[]).includes(msgType)) {
      return bad("msgType");
    }
    if (typeof content !== "string" || content.length === 0) return bad("content");
    if (msgType === "interactive" && byteLength(content) > FEISHU_REPLY_LIMITS.maxCardBytes) {
      return bad("card-too-large");
    }
    if (typeof uuid !== "string" || !UUID_RE.test(uuid)) return bad("uuid");
    return undefined;
  };

  const voidOk = (r: FeishuResult<FeishuJson>): FeishuResult<void> => (r.ok ? { ok: true, data: undefined } : r);

  return {
    async bootstrap(p) {
      const refuse = (reason: string, failure: FeishuFailure, cls: BootstrapFailureClass): BootstrapFailure => ({
        ok: false,
        class: cls,
        reason,
        ...(failure.code !== undefined ? { code: failure.code } : {}),
        ...(failure.msg !== undefined ? { msg: failure.msg } : {}),
        failure,
      });
      if (
        typeof p.appId !== "string" ||
        p.appId.length === 0 ||
        typeof p.appSecret !== "string" ||
        p.appSecret.length === 0
      ) {
        const f = bad("credentials");
        return refuse(f.reason, f, "refused");
      }
      const r = await http.json({
        op: "bootstrap",
        method: "POST",
        path: FEISHU_BOOTSTRAP.path,
        json: { AppID: p.appId, AppSecret: p.appSecret },
        headers: { locale: FEISHU_BOOTSTRAP.locale },
        timeoutMs: p.timeoutMs ?? FEISHU_BOOTSTRAP.timeoutMs,
        maxResponseBytes: FEISHU_BOOTSTRAP.maxBodyBytes,
        maxRequestBytes: FEISHU_BOOTSTRAP.maxBodyBytes,
        secrets: [p.appSecret],
        ...(p.signal !== undefined ? { signal: p.signal } : {}),
      });
      if (!r.ok) {
        if (r.kind === "destination" || r.kind === "bad-request") return refuse(r.reason, r, "refused");
        if (r.kind === "aborted") return refuse(r.reason, r, "aborted");
        if (r.kind === "api" && r.code !== undefined) {
          const c = classifyBootstrapCode(r.code);
          if (c.kind === "auth_failed") return refuse(r.reason, r, "auth_failed");
          if (c.kind === "conn_limit") return refuse(r.reason, r, "conn_limit");
          return refuse(r.reason, r, "retry");
        }
        // transport / timeout / 5xx / code-less HTTP status / oversize / unparseable ⇒ retry with backoff
        return refuse(r.reason, r, "retry");
      }

      const d = r.data.data;
      const rawUrl = d?.["URL"];
      if (!isAllowedWsUrl(rawUrl)) {
        const f = makeFailure("destination", "ws-url-not-allowed", { status: r.data.status });
        return refuse(f.reason, f, "refused");
      }
      let url: URL;
      try {
        url = new URL(rawUrl as string);
      } catch {
        const f = makeFailure("destination", "ws-url-not-allowed", { status: r.data.status });
        return refuse(f.reason, f, "refused");
      }
      const serviceId = url.searchParams.get("service_id");
      const deviceId = url.searchParams.get("device_id");
      if (
        serviceId === null ||
        !/^\d{1,10}$/.test(serviceId) ||
        Number(serviceId) > 2_147_483_647 ||
        deviceId === null ||
        deviceId.length === 0 ||
        deviceId.length > 256
      ) {
        const f = makeFailure("protocol", "protocol:endpoint-missing-ids", { status: r.data.status });
        return refuse(f.reason, f, "retry");
      }
      return {
        ok: true,
        data: {
          url: url.toString(),
          serviceId: Number(serviceId),
          deviceId,
          config: clampClientConfig(d?.["ClientConfig"]),
        },
      };
    },

    async send(p) {
      if (p.receiveIdType !== "chat_id" && p.receiveIdType !== "open_id") return bad("receiveIdType");
      if (!validId(p.receiveId)) return bad("receiveId");
      const invalid = checkContent(p.msgType, p.content, p.uuid);
      if (invalid !== undefined) return invalid;
      const r = await authed(p, (bearer) =>
        http.json({
          op: "send",
          method: "POST",
          path: "/open-apis/im/v1/messages",
          query: { receive_id_type: p.receiveIdType },
          token: bearer,
          json: { receive_id: p.receiveId, msg_type: p.msgType, content: p.content, uuid: p.uuid },
          ...common(p),
        }),
      );
      return r.ok ? sentFrom(r.data) : r;
    },

    async reply(p) {
      if (!validId(p.messageId)) return bad("messageId");
      const invalid = checkContent(p.msgType, p.content, p.uuid);
      if (invalid !== undefined) return invalid;
      const r = await authed(p, (bearer) =>
        http.json({
          op: "reply",
          method: "POST",
          path: `/open-apis/im/v1/messages/${encodeURIComponent(p.messageId)}/reply`,
          token: bearer,
          json: {
            msg_type: p.msgType,
            content: p.content,
            uuid: p.uuid,
            ...(p.replyInThread === true ? { reply_in_thread: true } : {}),
          },
          ...common(p),
        }),
      );
      return r.ok ? sentFrom(r.data) : r;
    },

    async patchCard(p) {
      if (!validId(p.messageId)) return bad("messageId");
      if (typeof p.card !== "string" || p.card.length === 0) return bad("card");
      if (byteLength(p.card) > FEISHU_REPLY_LIMITS.maxCardBytes) return bad("card-too-large");
      return voidOk(
        await authed(p, (bearer) =>
          http.json({
            op: "patch-card",
            method: "PATCH",
            path: `/open-apis/im/v1/messages/${encodeURIComponent(p.messageId)}`,
            token: bearer,
            json: { content: p.card },
            ...common(p),
          }),
        ),
      );
    },

    async addReaction(p) {
      if (!validId(p.messageId)) return bad("messageId");
      if (typeof p.emojiType !== "string" || !EMOJI_RE.test(p.emojiType)) return bad("emojiType");
      const r = await authed(p, (bearer) =>
        http.json({
          op: "reaction-add",
          method: "POST",
          path: `/open-apis/im/v1/messages/${encodeURIComponent(p.messageId)}/reactions`,
          token: bearer,
          json: { reaction_type: { emoji_type: p.emojiType } },
          ...common(p),
        }),
      );
      if (!r.ok) return r;
      const reactionId = str(r.data.data?.["reaction_id"]);
      if (reactionId === undefined) {
        return makeFailure("protocol", "protocol:missing-reaction-id", { status: r.data.status });
      }
      return { ok: true, data: { reactionId } };
    },

    async deleteReaction(p) {
      if (!validId(p.messageId)) return bad("messageId");
      if (!validId(p.reactionId)) return bad("reactionId");
      return voidOk(
        await authed(p, (bearer) =>
          http.json({
            op: "reaction-del",
            method: "DELETE",
            path: `/open-apis/im/v1/messages/${encodeURIComponent(p.messageId)}/reactions/${encodeURIComponent(p.reactionId)}`,
            token: bearer,
            ...common(p),
          }),
        ),
      );
    },

    async uploadImage(p) {
      const name = p.fileName ?? "image";
      if (!validFileName(name)) return bad("fileName");
      const blob = asBlob(p.bytes);
      if (blob.size === 0) return bad("empty");
      if (blob.size > FEISHU_FILE_LIMITS.outboundAutoImageMaxBytes) return bad("image-too-large");
      const r = await authed(p, (bearer) => {
        const form = new FormData();
        form.set("image_type", "message");
        form.set("image", blob, name);
        return http.json({
          op: "image-upload",
          method: "POST",
          path: "/open-apis/im/v1/images",
          token: bearer,
          form,
          ...common({ ...p, timeoutMs: p.timeoutMs ?? FEISHU_UPLOAD_TIMEOUT_MS }),
        });
      });
      if (!r.ok) return r;
      const imageKey = str(r.data.data?.["image_key"]);
      if (imageKey === undefined)
        return makeFailure("protocol", "protocol:missing-image-key", { status: r.data.status });
      return { ok: true, data: { imageKey } };
    },

    async uploadFile(p) {
      if (!validFileName(p.fileName)) return bad("fileName");
      const fileType = p.fileType ?? "stream";
      if (!(FEISHU_UPLOAD_FILE_TYPES as readonly string[]).includes(fileType)) return bad("fileType");
      const blob = asBlob(p.bytes);
      if (blob.size === 0) return bad("empty");
      if (blob.size > FEISHU_FILE_LIMITS.outboundUploadMaxBytes) return bad("file-too-large");
      const r = await authed(p, (bearer) => {
        const form = new FormData();
        form.set("file_type", fileType);
        form.set("file_name", p.fileName);
        form.set("file", blob, p.fileName);
        return http.json({
          op: "file-upload",
          method: "POST",
          path: "/open-apis/im/v1/files",
          token: bearer,
          form,
          ...common({ ...p, timeoutMs: p.timeoutMs ?? FEISHU_UPLOAD_TIMEOUT_MS }),
        });
      });
      if (!r.ok) return r;
      const fileKey = str(r.data.data?.["file_key"]);
      if (fileKey === undefined) return makeFailure("protocol", "protocol:missing-file-key", { status: r.data.status });
      return { ok: true, data: { fileKey } };
    },

    async downloadResource(p) {
      if (!validId(p.messageId)) return bad("messageId");
      if (!validId(p.fileKey)) return bad("fileKey");
      if (p.type !== "image" && p.type !== "file") return bad("type");
      if (!Number.isFinite(p.maxBytes) || p.maxBytes < 1) return bad("maxBytes");
      return authed(p, (bearer) =>
        http.stream(
          {
            op: "resource-download",
            method: "GET",
            path: `/open-apis/im/v1/messages/${encodeURIComponent(p.messageId)}/resources/${encodeURIComponent(p.fileKey)}`,
            query: { type: p.type },
            token: bearer,
            ...common({ ...p, timeoutMs: p.timeoutMs ?? FEISHU_FILE_LIMITS.inboundTimeoutMs }),
          },
          { maxBytes: Math.floor(p.maxBytes), sink: p.sink },
        ),
      );
    },

    async botInfo(p) {
      const r = await authed(p, (bearer) =>
        http.json({
          op: "bot-info",
          method: "GET",
          path: "/open-apis/bot/v3/info",
          token: bearer,
          ...common(p),
        }),
      );
      if (!r.ok) return r;
      const bot = r.data.body["bot"] ?? r.data.data?.["bot"];
      const botObj = bot !== null && typeof bot === "object" ? (bot as Record<string, unknown>) : undefined;
      const openId = botObj?.["open_id"];
      if (typeof openId !== "string" || !FEISHU_OPEN_ID_RE.test(openId)) {
        return makeFailure("protocol", "protocol:invalid-bot-open-id", { status: r.data.status });
      }
      const appName = str(botObj?.["app_name"]);
      return { ok: true, data: { openId, ...(appName !== undefined ? { appName } : {}) } };
    },
  };
}
