/**
 * Programmable fake of the Feishu open-API HTTP surface (bot plan §11 `fake-http.ts`, package F2).
 *
 * A **fetch seam**, not a socket server: `fake.fetch` is handed to `createFeishuHttp({ fetch })`. It honours
 * `init.signal` (a hanging call rejects with an AbortError exactly like a real aborted fetch), never reads
 * env, and has no timers of its own — pair it with {@link createFakeClock} for deadline tests.
 *
 * Defaults model the probe-verified tenant behaviour (`docs/dev/feishu-bot/probe-results.md`):
 * - `POST /open-apis/auth/v3/tenant_access_token/internal` — wrong secret ⇒ HTTP 200 + code `10014` (V11);
 * - `POST /callback/ws/endpoint` — wrong secret ⇒ HTTP 200 + code `1000040345`; success carries `URL` +
 *   `ClientConfig` (V1);
 * - bearer-checked `/open-apis/im/**` and `/open-apis/bot/**`: stale/unknown token ⇒ HTTP 400 + `99991663`;
 * - `POST …/messages` / `…/reply` — `uuid`-idempotent (the same uuid returns the SAME message id and does not
 *   add a sent message; `reply_in_thread:true` returns a `thread_id`, V8);
 * - `PATCH …/messages/:id`, reactions add/delete, `POST …/images` / `…/files` (multipart), `GET …/resources/:key`,
 *   `GET /open-apis/bot/v3/info` (top-level `bot`).
 *
 * Extension points for later packages (F3/F4/F7/F8): `on()` registers a route handler (first registered wins,
 * user handlers run before defaults), `script()` queues one-shot responses for a matcher, and
 * {@link FakeResponse} can express every failure shape the client must classify.
 */

export interface FakeCall {
  method: string;
  /** path only (no query) */
  path: string;
  query: Record<string, string>;
  /** lower-cased header names */
  headers: Record<string, string>;
  /** parsed JSON body (`undefined` for none / multipart) */
  json: unknown;
  /** multipart summary (`undefined` otherwise) */
  form?: { fields: Record<string, string>; file?: { field: string; name: string; size: number; type: string } };
  signal: AbortSignal | undefined;
  /** the `redirect` option the client passed (the client under test must always pass `"error"`) */
  redirect: RequestRedirect | undefined;
  /** full URL as requested (tests only; production code never logs it) */
  url: string;
}

export interface FakeResponse {
  status?: number;
  /** JSON body (default content-type `application/json`) */
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
  /** body delivered in chunks; `hangAfter` stalls forever (until the call's signal aborts) after the last chunk */
  chunks?: Uint8Array[];
  hangAfter?: boolean;
  headers?: Record<string, string>;
  /** reject the fetch itself (connection refused/reset) */
  networkError?: boolean;
  /** never settle until the call's signal aborts */
  hang?: boolean;
}

export type FakeHandler = (call: FakeCall) => FakeResponse | undefined | Promise<FakeResponse | undefined>;

export interface FakeFeishuOptions {
  appId?: string;
  appSecret?: string;
  /** `expire` the token endpoint reports (seconds, default 7200) */
  tokenExpireS?: number;
  /** WS URL returned by bootstrap (default a valid `msg-frontier.feishu.cn` URL) */
  wsUrl?: string;
  botOpenId?: string;
}

export interface FakeFeishu {
  readonly appId: string;
  readonly appSecret: string;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** every call in order */
  calls: FakeCall[];
  callsTo(method: string, pathPart: string | RegExp): FakeCall[];
  /** register a handler for `METHOD` + path (string = exact, RegExp = test); returning `undefined` falls through */
  on(method: string, path: string | RegExp, handler: FakeHandler): void;
  /** queue one-shot responses (consumed in order) for `METHOD` + path; falls through to defaults when empty */
  script(method: string, path: string | RegExp, ...responses: FakeResponse[]): void;
  /** tokens currently accepted by bearer-checked routes */
  validTokens: Set<string>;
  /** invalidate every issued token (the next bearer call gets 99991663) */
  expireTokens(): void;
  /** messages the fake considers delivered, in order (uuid-deduped) */
  sent: Array<{ messageId: string; uuid: string; kind: "send" | "reply"; body: Record<string, unknown> }>;
  /** resources served by `GET …/resources/:key` */
  resources: Map<string, { bytes: Uint8Array; contentType?: string; contentLength?: boolean }>;
  /** tokens issued so far */
  tokensIssued(): number;
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal === undefined) return; // never settles (the test must not rely on this)
    if (signal.aborted) return reject(abortError());
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

function bodyStream(
  chunks: Uint8Array[],
  hangAfter: boolean,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]!);
        return;
      }
      if (!hangAfter) {
        controller.close();
        return;
      }
      try {
        await waitForAbort(signal);
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

async function toResponse(r: FakeResponse, signal: AbortSignal | undefined): Promise<Response> {
  if (r.networkError === true) throw new TypeError("fetch failed");
  if (r.hang === true) return waitForAbort(signal);
  const headers = new Headers(r.headers);
  const status = r.status ?? 200;
  if (r.chunks !== undefined) {
    return new Response(bodyStream(r.chunks, r.hangAfter === true, signal), { status, headers });
  }
  if (r.bytes !== undefined) return new Response(r.bytes as BodyInit, { status, headers });
  if (r.text !== undefined) return new Response(r.text, { status, headers });
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(r.json ?? {}), { status, headers });
}

export function createFakeFeishu(opts: FakeFeishuOptions = {}): FakeFeishu {
  const appId = opts.appId ?? "cli_fake_app";
  const appSecret = opts.appSecret ?? "fake-app-secret-0123456789abcdef";
  const botOpenId = opts.botOpenId ?? "ou_fakebot00000001";
  const wsUrl =
    opts.wsUrl ??
    "wss://msg-frontier.feishu.cn/ws/v2?device_id=7000000000000000001&service_id=33&ticket=fake-ticket-secret";

  let tokenSeq = 0;
  let idSeq = 0;
  const validTokens = new Set<string>();
  const calls: FakeCall[] = [];
  const sent: FakeFeishu["sent"] = [];
  const byUuid = new Map<string, string>();
  const resources: FakeFeishu["resources"] = new Map();
  const userHandlers: Array<{ method: string; path: string | RegExp; handler: FakeHandler }> = [];
  const scripts: Array<{ method: string; path: string | RegExp; queue: FakeResponse[] }> = [];

  const matches = (m: { method: string; path: string | RegExp }, call: FakeCall): boolean =>
    m.method === call.method && (typeof m.path === "string" ? m.path === call.path : m.path.test(call.path));

  const bearerOk = (call: FakeCall): boolean => {
    const h = call.headers["authorization"];
    return typeof h === "string" && h.startsWith("Bearer ") && validTokens.has(h.slice(7));
  };
  const badToken: FakeResponse = {
    status: 400,
    json: { code: 99991663, msg: "Invalid access token for authorization." },
  };
  const ok = (data: unknown): FakeResponse => ({ json: { code: 0, msg: "success", data } });

  function defaults(call: FakeCall): FakeResponse {
    const { method, path } = call;
    const body = (call.json ?? {}) as Record<string, unknown>;

    if (method === "POST" && path === "/open-apis/auth/v3/tenant_access_token/internal") {
      if (body["app_id"] !== appId || body["app_secret"] !== appSecret) {
        return { json: { code: 10014, msg: "app secret invalid" } };
      }
      const token = `t-fake${++tokenSeq}${"x".repeat(24)}`;
      validTokens.add(token);
      return { json: { code: 0, msg: "ok", tenant_access_token: token, expire: opts.tokenExpireS ?? 7200 } };
    }
    if (method === "POST" && path === "/callback/ws/endpoint") {
      if (body["AppID"] !== appId || body["AppSecret"] !== appSecret) {
        return { json: { code: 1000040345, msg: "system busy or invalid credentials" } };
      }
      return {
        json: {
          code: 0,
          msg: "",
          data: {
            URL: wsUrl,
            ClientConfig: { PingInterval: 90, ReconnectCount: -1, ReconnectInterval: 90, ReconnectNonce: 25 },
          },
        },
      };
    }

    if (!path.startsWith("/open-apis/")) return { status: 404, json: { code: 404, msg: "not found" } };
    if (!bearerOk(call)) return badToken;

    if (method === "POST" && path === "/open-apis/im/v1/messages") {
      return deliver(call, body, "send");
    }
    let m = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(path);
    if (method === "POST" && m) return deliver(call, body, "reply", decodeURIComponent(m[1]!));
    m = /^\/open-apis\/im\/v1\/messages\/([^/]+)$/.exec(path);
    if (method === "PATCH" && m) return ok({});
    m = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reactions$/.exec(path);
    if (method === "POST" && m) return ok({ reaction_id: `rx_fake_${++idSeq}`, reaction_type: body["reaction_type"] });
    m = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reactions\/([^/]+)$/.exec(path);
    if (method === "DELETE" && m) return ok({ reaction_id: decodeURIComponent(m[2]!) });
    if (method === "POST" && path === "/open-apis/im/v1/images") return ok({ image_key: `img_v3_fake_${++idSeq}` });
    if (method === "POST" && path === "/open-apis/im/v1/files") return ok({ file_key: `file_v3_fake_${++idSeq}` });
    m = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/resources\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const res = resources.get(decodeURIComponent(m[2]!));
      if (res === undefined) return { status: 404, json: { code: 234043, msg: "resource not found" } };
      return {
        bytes: res.bytes,
        headers: {
          "content-type": res.contentType ?? "application/octet-stream",
          ...(res.contentLength === false ? {} : { "content-length": String(res.bytes.length) }),
        },
      };
    }
    if (method === "GET" && path === "/open-apis/bot/v3/info") {
      return {
        json: { code: 0, msg: "ok", bot: { activate_status: 2, app_name: "pi@fake-host", open_id: botOpenId } },
      };
    }
    return { status: 404, json: { code: 404, msg: "not found" } };
  }

  function deliver(
    call: FakeCall,
    body: Record<string, unknown>,
    kind: "send" | "reply",
    parent?: string,
  ): FakeResponse {
    const uuid = typeof body["uuid"] === "string" ? body["uuid"] : "";
    let messageId = uuid ? byUuid.get(uuid) : undefined;
    if (messageId === undefined) {
      messageId = `om_fake_${++idSeq}`;
      if (uuid) byUuid.set(uuid, messageId);
      sent.push({ messageId, uuid, kind, body });
    }
    const data: Record<string, unknown> = {
      message_id: messageId,
      chat_id: kind === "send" ? String(body["receive_id"] ?? "oc_fake") : "oc_fake",
      msg_type: body["msg_type"],
      create_time: "1760000000000",
    };
    if (kind === "reply") {
      data["root_id"] = parent;
      data["parent_id"] = parent;
      if (body["reply_in_thread"] === true) data["thread_id"] = `omt_fake_${parent}`;
    }
    void call;
    return ok(data);
  }

  async function parseBody(init: RequestInit): Promise<Pick<FakeCall, "json" | "form">> {
    const b = init.body;
    if (typeof b === "string") {
      try {
        return { json: JSON.parse(b) as unknown };
      } catch {
        return { json: undefined };
      }
    }
    if (b instanceof FormData) {
      const fields: Record<string, string> = {};
      let file: { field: string; name: string; size: number; type: string } | undefined;
      for (const [k, v] of b.entries()) {
        if (typeof v === "string") fields[k] = v;
        else file = { field: k, name: v.name, size: v.size, type: v.type };
      }
      return { json: undefined, form: { fields, ...(file !== undefined ? { file } : {}) } };
    }
    return { json: undefined };
  }

  const fake: FakeFeishu = {
    appId,
    appSecret,
    calls,
    sent,
    resources,
    validTokens,
    tokensIssued: () => tokenSeq,
    expireTokens: () => validTokens.clear(),
    callsTo: (method, pathPart) =>
      calls.filter(
        (c) =>
          c.method === method && (typeof pathPart === "string" ? c.path.includes(pathPart) : pathPart.test(c.path)),
      ),
    on(method, path, handler) {
      userHandlers.push({ method, path, handler });
    },
    script(method, path, ...responses) {
      scripts.push({ method, path, queue: [...responses] });
    },
    async fetch(input, init) {
      const url = new URL(input);
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      const parsed = await parseBody(init);
      const call: FakeCall = {
        method: (init.method ?? "GET").toUpperCase(),
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers,
        json: parsed.json,
        ...(parsed.form !== undefined ? { form: parsed.form } : {}),
        signal: init.signal ?? undefined,
        redirect: init.redirect,
        url: input,
      };
      calls.push(call);
      if (call.signal?.aborted) throw abortError();

      for (const s of scripts) {
        if (matches(s, call) && s.queue.length > 0) return toResponse(s.queue.shift()!, call.signal);
      }
      for (const h of userHandlers) {
        if (!matches(h, call)) continue;
        const r = await h.handler(call);
        if (r !== undefined) return toResponse(r, call.signal);
      }
      return toResponse(defaults(call), call.signal);
    },
  };
  return fake;
}

// ---------------------------------------------------------------------------
// fake clock
// ---------------------------------------------------------------------------

export interface FakeClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** advance time, firing due timers in order (timers scheduled by fired callbacks are honoured) */
  advance(ms: number): void;
  pending(): number;
}

export function createFakeClock(start = 1_000_000): FakeClock {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers)
          if (entry[1].at <= target && (next === undefined || entry[1].at < next[1].at)) next = entry;
        if (next === undefined) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

/** Let queued microtasks / stream pulls run (the fake fetch is async). */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
