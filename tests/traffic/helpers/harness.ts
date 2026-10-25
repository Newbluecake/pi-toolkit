/**
 * traffic T2b 测试夹具：模拟 pi 的会话请求路径（plan §1 事实 6）。
 *
 *   applyAuth → before_provider_headers（就地改 headers）→ buildParams → before_provider_request（payload）
 *   → client.create → globalThis.fetch(url, { headers, body })（SDK 内重试复用同一 headers 与正文）
 *   → 2xx ⇒ after_provider_response（非 2xx：SDK 抛 APIError，pi 不调 onResponse）
 *
 * 每次 `activate()` = 一次扩展激活（一个 runner 闭包），与真实 pi 的 `moduleCache:false` 一致。上游 stub 在
 * `/record on` 之前挂到 `globalThis.fetch`，于是 trampoline 的固定下游就是 stub。
 */
import { join } from "node:path";
import { peekEngine, type TrafficEngine } from "../../../src/traffic/engine.js";
import { wireTraffic, type TrafficWiring } from "../../../src/traffic/index.js";
import { TICKET_HEADER } from "../../../src/traffic/tap.js";

export type Handler = (event: any, ctx: any) => unknown;

export interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  signal: AbortSignal | null;
  at: number;
}

export type StubResponder = (call: StubCall, index: number) => Response | Promise<Response>;

export interface Upstream {
  calls: StubCall[];
  /** 下一次调用的应答（FIFO）；空 ⇒ `fallback`。 */
  queue: StubResponder[];
  fallback: StubResponder;
  fetch: typeof globalThis.fetch;
}

export function sse(chunks: string[] = ['data: {"type":"message_stop"}\n\n'], status = 200): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(enc.encode(chunk));
        c.close();
      },
    }),
    { status, headers: { "content-type": "text/event-stream", "request-id": `req-${Math.random()}` } },
  );
}

export function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function toCall(input: any, init: any): Promise<StubCall> {
  const headers: Record<string, string> = {};
  let body: string | null = null;
  let url: string;
  let method: string;
  let signal: AbortSignal | null = null;
  if (input instanceof Request) {
    url = input.url;
    method = input.method;
    input.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    body = input.body ? await input.clone().text() : null;
    signal = input.signal;
  } else {
    url = String(input);
    method = String(init?.method ?? "GET");
    const h = init?.headers;
    if (h instanceof Headers) h.forEach((v, k) => (headers[k.toLowerCase()] = v));
    else if (Array.isArray(h)) for (const [k, v] of h) headers[String(k).toLowerCase()] = String(v);
    else if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    const b = init?.body;
    body = typeof b === "string" ? b : b instanceof Uint8Array ? Buffer.from(b).toString("latin1") : null;
    signal = init?.signal ?? null;
  }
  return { url, method, headers, body, signal, at: performance.now() };
}

export function createUpstream(fallback: StubResponder = () => sse()): Upstream {
  const up: Upstream = {
    calls: [],
    queue: [],
    fallback,
    fetch: (async (input: any, init?: any) => {
      const call = await toCall(input, init);
      up.calls.push(call);
      const responder = up.queue.shift() ?? up.fallback;
      return responder(call, up.calls.length - 1);
    }) as typeof globalThis.fetch,
  };
  return up;
}

export interface Activation {
  readonly handlers: Map<string, Handler[]>;
  readonly commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  readonly sessionId: string;
  readonly notes: string[];
  /** wireTraffic 的返回值（T3 / T5 消费的端口）。 */
  readonly wiring: TrafficWiring | undefined;
  ctx(over?: { api?: string; baseUrl?: string | null; model?: string; mode?: string }): any;
  emit(name: string, event: Record<string, unknown>, ctx?: any): Promise<unknown>;
}

export interface ModelInfo {
  api: string;
  baseUrl: string | null;
  id: string;
  provider: string;
}

export const BASE_URL = "https://api.example.test/v1";
export const URL_MESSAGES = `${BASE_URL}/messages`;

export function activate(opts: {
  role?: "host" | "child";
  owner?: object;
  dbPath: string;
  sessionId: string;
  model?: Partial<ModelInfo>;
  childPersist?: boolean;
}): Activation {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const notes: string[] = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand: (name: string, o: { handler: (args: string, ctx: any) => Promise<void> }) => {
      commands.set(name, o.handler);
    },
  };
  const wiring = wireTraffic(pi as any, {
    enabled: true,
    role: opts.role ?? "host",
    ...(opts.owner ? { owner: opts.owner } : {}),
    dbPath: opts.dbPath,
    legacyDbPath: null,
    ...(opts.childPersist !== undefined ? { childPersist: opts.childPersist } : {}),
  });
  const baseModel: ModelInfo = {
    api: "anthropic-messages",
    baseUrl: BASE_URL,
    id: "test-model",
    provider: "test-provider",
    ...(opts.model ?? {}),
  };
  const ctx = (over: { api?: string; baseUrl?: string | null; model?: string; mode?: string } = {}): any => ({
    mode: over.mode ?? "print",
    model: {
      ...baseModel,
      ...(over.api !== undefined ? { api: over.api } : {}),
      ...(over.baseUrl !== undefined ? { baseUrl: over.baseUrl } : {}),
      ...(over.model !== undefined ? { id: over.model } : {}),
    },
    ui: { notify: (m: string) => notes.push(m) },
    sessionManager: { getSessionId: () => opts.sessionId },
    cwd: process.cwd(),
  });
  return {
    handlers,
    commands,
    sessionId: opts.sessionId,
    notes,
    wiring,
    ctx,
    async emit(name, event, c = ctx()) {
      let last: unknown;
      for (const h of handlers.get(name) ?? []) last = await h({ type: name, ...event }, c);
      return last;
    },
  };
}

/** `/record on`（print 模式：不起网页服务）。调用前须已把上游 stub 挂到 globalThis.fetch。 */
export async function recordOn(host: Activation): Promise<TrafficEngine> {
  await host.commands.get("record")!("on", host.ctx({ mode: "print" }));
  const engine = peekEngine();
  if (!engine) throw new Error(`record on failed: ${host.notes.join("\n")}`);
  return engine;
}

/** 一次会话请求的分步驱动（交错用例需要逐步控制）。 */
export interface PiRequest {
  headers: Record<string, string | null>;
  ticket(): string | null;
  /** before_provider_request。 */
  payload(payload: unknown, ctx?: any): Promise<void>;
  /** SDK 发一次 fetch（含 SDK 内重试：同 headers 再调一次）。返回 Response。 */
  fetch(body: string, url?: string, extra?: RequestInit): Promise<Response>;
  /** 2xx ⇒ after_provider_response。 */
  respond(res: Response, ctx?: any): Promise<void>;
}

export async function beginRequest(act: Activation, ctx: any = act.ctx()): Promise<PiRequest> {
  const headers: Record<string, string | null> = {
    "content-type": "application/json",
    "x-api-key": `key-${act.sessionId}`,
  };
  await act.emit("before_provider_headers", { headers }, ctx);
  return {
    headers,
    ticket: () => (headers[TICKET_HEADER] as string | undefined) ?? null,
    payload: async (payload, c = ctx) => {
      await act.emit("before_provider_request", { payload }, c);
    },
    fetch: (body, url = URL_MESSAGES, extra = {}) => {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) if (v !== null) h[k] = v;
      return globalThis.fetch(url, { method: "POST", headers: h, body, ...extra });
    },
    respond: async (res, c = ctx) => {
      if (res.ok) {
        const rh: Record<string, string> = {};
        res.headers.forEach((v, k) => (rh[k] = v));
        await act.emit("after_provider_response", { status: res.status, headers: rh }, c);
      }
    },
  };
}

/** 一次完整的「无交错」请求：headers → payload → fetch → response → 读完流 → assistant message_end。 */
export async function fullRequest(
  act: Activation,
  payload: Record<string, unknown>,
  opts: { ctx?: any; messageEnd?: boolean } = {},
): Promise<Response> {
  const c = opts.ctx ?? act.ctx();
  const req = await beginRequest(act, c);
  await req.payload(payload, c);
  const res = await req.fetch(JSON.stringify(payload));
  await req.respond(res, c);
  await res.text();
  if (opts.messageEnd !== false) await act.emit("message_end", { message: { role: "assistant", content: [] } }, c);
  return res;
}

export function dbFile(dir: string): string {
  return join(dir, "traffic.db");
}
