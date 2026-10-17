import { createInterface } from "node:readline/promises";
import type { Interface } from "node:readline/promises";
import { ackFrame, decodeFrame, encodeFrame, Fragments, header, MAX_FRAME } from "./codec.ts";
import type { Frame } from "./codec.ts";
import { allowedUrl, apiBase, probeDir, redact } from "./safety.ts";
import { apiFailure, missingScopes, ProbeError, transportFailure } from "./errors.ts";
import type { Credentials } from "./safety.ts";

export type Status = "pass" | "fail" | "skipped" | "unknown";
export type StepId = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8";
export const STEPS: StepId[] = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"];
export const QUESTIONS: Record<string, string> = {
  V1: "PersonalAgent bootstrap + 长连接",
  V2a: "默认消息订阅",
  V2b: "默认卡片回调订阅",
  V3: "默认 reactions / upload / download / group @ 权限",
  V4: "入群 / 话题群",
  V5: "schema-2.0 PATCH ± update_multi",
  V6: "ACK / payload_encoding",
  V7: "跨连接重投 / 双连接分配（有限观察窗口）",
  V8: "普通群 reply_in_thread / thread_id",
  V9: "Typing emoji",
  V10: "create_time 单位",
  V11: "错误凭据代码",
  V12: "非创建者可见 / 可私聊",
};
export interface Report {
  version: 1;
  startedAt: string;
  finishedAt?: string;
  interrupted: boolean;
  upstream: string;
  live: boolean; // Any network attempt, not proof of successful live validation.
  untestedLive: StepId[];
  steps: Record<
    StepId,
    { status: Status; liveAttempted: boolean; droppedObservations: number; observations: unknown[] }
  >;
  facts: Record<string, { status: Status; observations: unknown[] }>;
}
export interface EventRecord {
  at: number;
  frame: Frame;
  envelope: any;
  connection: string;
  ackSent: boolean;
}
export class Unknown extends Error {}
export class Probe {
  signal: AbortSignal;
  controller = new AbortController();
  input: Interface;
  credentials?: Credentials;
  credentialDir = probeDir;
  secrets: string[] = [];
  token?: string;
  tokenUntil = 0;
  tenantKey?: string;
  current: StepId = "P1";
  timeoutMs: number;
  sockets = new Set<Connection>();
  report: Report;
  observationBytes = new Map<StepId, number>();
  eof = false;
  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
    this.signal = this.controller.signal;
    this.input = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    this.report = {
      version: 1,
      startedAt: new Date().toISOString(),
      interrupted: false,
      live: false,
      untestedLive: STEPS.slice(),
      upstream: "larksuite/node-sdk@b188be60134d409b61259546bcf69c731d2b0b7c",
      steps: Object.fromEntries(
        STEPS.map((id) => [id, { status: "skipped", liveAttempted: false, droppedObservations: 0, observations: [] }]),
      ) as unknown as Report["steps"],
      facts: Object.fromEntries(Object.keys(QUESTIONS).map((id) => [id, { status: "unknown", observations: [] }])),
    };
    // A TTY's raw-mode Ctrl-C is a readline event, not necessarily process SIGINT.
    this.input.on("SIGINT", () => {
      this.report.interrupted = true;
      this.close();
    });
    this.input.on("close", () => {
      this.eof = true;
      if (!this.signal.aborted) {
        this.report.interrupted = true;
        this.close();
      }
    });
  }
  record(kind: string, value: unknown): void {
    const step = this.report.steps[this.current];
    const data = this.snapshot(value);
    const entry = { at: new Date().toISOString(), kind, data };
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    const used = this.observationBytes.get(this.current) ?? 0;
    if (step.observations.length >= 256 || used + bytes > 512 * 1024) {
      step.droppedObservations++;
      return;
    }
    this.observationBytes.set(this.current, used + bytes);
    step.observations.push(entry);
  }
  snapshot(value: unknown): unknown {
    const safe = redact(value, "", this.secrets);
    const size = Buffer.byteLength(JSON.stringify(safe));
    return size <= 32 * 1024 ? safe : { reason: "observation-too-large", redactedBytes: size };
  }
  fact(id: string, status: Status, value: unknown): void {
    const fact = this.report.facts[id]!;
    if (fact.observations.length >= 64) return;
    fact.observations.push({ step: this.current, status, data: this.snapshot(value) });
    // A successful sub-capability must not hide another untested/failed part:
    // e.g. two-connection delivery says nothing about cross-connection redelivery.
    const statuses = (fact.observations as { status: Status }[]).map((o) => o.status);
    fact.status = statuses.includes("fail")
      ? "fail"
      : statuses.includes("unknown")
        ? "unknown"
        : statuses.includes("pass")
          ? "pass"
          : "skipped";
  }
  async ask(text: string, ms = this.timeoutMs): Promise<string> {
    if (this.signal.aborted) throw new Error("interrupted");
    if (this.eof) throw new Unknown("stdin-closed");
    const ac = new AbortController();
    const cancel = () => ac.abort();
    this.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, ms);
    timer.unref();
    try {
      return (await this.input.question(text + "\n> ", { signal: ac.signal })).trim();
    } catch {
      if (this.signal.aborted) throw new Error("interrupted");
      throw new Unknown("prompt-timeout");
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", cancel);
    }
  }
  async wait(ms: number): Promise<void> {
    if (this.signal.aborted) throw new Error("interrupted");
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        reject(new Error("interrupted"));
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      this.signal.addEventListener("abort", abort, { once: true });
    });
  }
  consistent(e: EventRecord): boolean {
    const c = this.needCredentials();
    if (!identityConsistent(e, c)) return false;
    const tenant = e.envelope.header.tenant_key;
    if (this.tenantKey && tenant !== this.tenantKey) return false;
    if (!this.tenantKey && sender(e) === c.ownerOpenId) this.tenantKey = tenant;
    return true;
  }
  needCredentials(): Credentials {
    if (!this.credentials) throw new ProbeError("credential", "registration-or-reuse-required");
    return this.credentials;
  }
  async request(
    url: string,
    kind: "api" | "accounts",
    init: RequestInit = {},
    limit = MAX_FRAME,
    timeoutMs = 8000,
  ): Promise<{ status: number; body: any }> {
    allowedUrl(url, kind);
    if (this.signal.aborted) throw new Error("interrupted");
    const ac = new AbortController();
    const cancel = () => ac.abort();
    this.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, timeoutMs);
    timer.unref();
    this.markLive();
    try {
      const response = await fetch(url, { ...init, redirect: "error", signal: ac.signal });
      const bytes = await boundedBody(response, limit);
      let body: any;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        body = { error: "non-json", bytes: bytes.length };
      }
      return { status: response.status, body };
    } catch (error) {
      throw transportFailure(error, this.signal.aborted, ac.signal.aborted);
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", cancel);
    }
  }
  markLive(): void {
    this.report.live = true;
    this.report.steps[this.current].liveAttempted = true;
    this.report.untestedLive = this.report.untestedLive.filter((id) => id !== this.current);
  }
  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenUntil) return this.token;
    const c = this.needCredentials();
    const r = await this.request(apiBase(c.brand) + "/open-apis/auth/v3/tenant_access_token/internal", "api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }),
    });
    this.record("token-result", {
      status: r.status,
      code: r.body?.code,
      scopes: missingScopes(r.body?.msg, this.secrets),
    });
    if (r.status !== 200 || r.body?.code !== 0 || typeof r.body?.tenant_access_token !== "string")
      throw apiFailure(r.status, r.body, this.secrets);
    this.token = r.body.tenant_access_token;
    this.secrets.push(this.token!);
    this.tokenUntil = Date.now() + Math.max(0, Math.min(7200, Number(r.body.expire) || 0) - 300) * 1000;
    return this.token!;
  }
  async api(path: string, method = "GET", body?: unknown): Promise<any> {
    const c = this.needCredentials(),
      token = await this.accessToken();
    const headers: Record<string, string> = { Authorization: "Bearer " + token };
    const multipart = body instanceof FormData;
    if (body !== undefined && !multipart) headers["Content-Type"] = "application/json";
    const r = await this.request(apiBase(c.brand) + path, "api", {
      method,
      headers,
      ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
    });
    const operation = path
      .split("?")[0]!
      .replace(/(\/messages\/)[^/]+/, "$1:id")
      .replace(/(\/reactions\/)[^/]+/, "$1:id");
    this.record("api-result", {
      operation,
      method,
      status: r.status,
      response: r.body,
      scopes: missingScopes(r.body?.msg, this.secrets),
    });
    if (r.status < 200 || r.status >= 300 || r.body?.code !== 0) throw apiFailure(r.status, r.body, this.secrets);
    return r.body.data;
  }
  async bootstrap(secret?: string): Promise<any> {
    const c = this.needCredentials();
    const r = await this.request(
      apiBase(c.brand) + "/callback/ws/endpoint",
      "api",
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", locale: "zh" },
        body: JSON.stringify({ AppID: c.appId, AppSecret: secret ?? c.appSecret }),
      },
      64 * 1024,
    );
    this.record("bootstrap", { status: r.status, ...r.body });
    return r;
  }
  async connect(label: string): Promise<Connection> {
    const r = await this.bootstrap();
    if (r.status !== 200 || r.body?.code !== 0) throw apiFailure(r.status, r.body, this.secrets);
    const url = allowedUrl(r.body.data?.URL, "ws");
    const serviceId = url.searchParams.get("service_id"),
      deviceId = url.searchParams.get("device_id");
    if (!serviceId || !/^\d+$/.test(serviceId) || Number(serviceId) > 2147483647 || !deviceId)
      throw new ProbeError("protocol", "endpoint-missing-ids");
    this.record("endpoint", {
      host: url.hostname,
      service_id: Number(serviceId),
      device_id: deviceId,
      ClientConfig: r.body.data.ClientConfig,
    });
    const conn = new Connection(this, label, Number(serviceId));
    this.sockets.add(conn);
    try {
      await conn.open(url.toString(), r.body.data.ClientConfig);
    } catch (e) {
      conn.close();
      throw e;
    }
    return conn;
  }
  close(): void {
    this.controller.abort();
    for (const c of this.sockets) c.close();
    this.input.close();
  }
}
export async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      length += r.value.length;
      if (length > limit) {
        await reader.cancel();
        throw new ProbeError("protocol", "body-too-large");
      }
      chunks.push(r.value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const b of chunks) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}
export class Connection {
  probe: Probe;
  label: string;
  service: number;
  ws?: WebSocket;
  fragments = new Fragments();
  events: EventRecord[] = [];
  listeners = new Set<(e: EventRecord) => void>();
  closeListeners = new Set<() => void>();
  pongs: unknown[] = [];
  pingCount = 0;
  ack = true;
  pingTimer?: NodeJS.Timeout;
  livenessTimer?: NodeJS.Timeout;
  config: any;
  closed = false;
  constructor(probe: Probe, label: string, service: number) {
    this.probe = probe;
    this.label = label;
    this.service = service;
  }
  async open(url: string, config: unknown): Promise<void> {
    this.config = config;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      throw new ProbeError("ws-handshake-failed");
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.addEventListener("error", () => {
      if (!this.closed) this.probe.record("ws-error", { connection: this.label });
    });
    ws.addEventListener("close", (e) => {
      if (this.closed) return;
      this.probe.record("ws-close", { connection: this.label, code: e.code });
      this.close();
    });
    ws.addEventListener("message", (e) => this.receive(e.data));
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener("open", opened);
        ws.removeEventListener("error", failed);
        ws.removeEventListener("close", failed);
        this.probe.signal.removeEventListener("abort", failed);
      };
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new ProbeError("ws-handshake-failed"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new ProbeError("timeout", "ws-handshake"));
      }, 10_000);
      timer.unref();
      ws.addEventListener("open", opened, { once: true });
      ws.addEventListener("error", failed, { once: true });
      ws.addEventListener("close", failed, { once: true });
      this.probe.signal.addEventListener("abort", failed, { once: true });
    });
    if (this.closed || this.probe.signal.aborted) throw new Error("ws-closed");
    this.probe.record("ws-open", { connection: this.label });
    this.ping();
  }
  send(frame: Frame): boolean {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return false;
    if (this.ws.bufferedAmount > MAX_FRAME) {
      this.close();
      return false;
    }
    try {
      this.ws.send(encodeFrame(frame));
      return true;
    } catch {
      this.close();
      return false;
    }
  }
  ping(): void {
    clearTimeout(this.pingTimer);
    if (
      !this.send({ seqId: 0n, logId: 0n, service: this.service, method: 0, headers: [{ key: "type", value: "ping" }] })
    )
      return;
    this.pingCount++;
    clearTimeout(this.livenessTimer);
    this.livenessTimer = setTimeout(() => {
      this.probe.record("ws-liveness-timeout", { connection: this.label });
      this.close();
    }, 30_000);
    this.livenessTimer.unref();
    const seconds = Number(this.config?.PingInterval);
    const interval = Number.isFinite(seconds) ? Math.max(10, Math.min(300, seconds)) : 120;
    this.pingTimer = setTimeout(() => this.ping(), interval * 1000);
    this.pingTimer.unref();
  }
  receive(data: unknown): void {
    if (this.closed) return;
    try {
      if (!(data instanceof ArrayBuffer)) throw new Error("non-binary");
      const frame = decodeFrame(new Uint8Array(data));
      clearTimeout(this.livenessTimer);
      if (frame.method === 0) {
        const type = header(frame, "type");
        if (type === "pong") {
          const payload = frame.payload?.length
            ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload))
            : null;
          if (this.pongs.length < 16) this.pongs.push(payload);
          if (payload && typeof payload === "object") this.config = payload;
          this.probe.record("pong", { connection: this.label, ClientConfig: payload });
        }
        return;
      }
      if (frame.method !== 1) return;
      if (header(frame, "type") !== "event") {
        // Pinned SDK handleEventData returns before ACK for every non-event type.
        this.probe.record("ignored-data-type", { type: header(frame, "type"), ackSent: false });
        return;
      }
      const bytes = this.fragments.add(frame);
      if (!bytes) return;
      // SDK parses bytes as UTF-8 JSON regardless of the advertised encoding.
      const encoding = frame.payloadEncoding ?? "";
      let envelope: any;
      try {
        envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        const ackSent = this.ack && this.send(ackFrame(frame));
        this.probe.record("undecodable-json", {
          payload_encoding: encoding,
          bytes: bytes.length,
          ackSent,
          ackPayload: ackSent ? { code: 200 } : null,
        });
        return;
      }
      const event: EventRecord = { at: Date.now(), frame, envelope, connection: this.label, ackSent: false };
      event.ackSent = this.ack && this.send(ackFrame(frame));
      // Bound retained raw events independently of the 1 MiB per-event bound.
      this.events.push(event);
      while (this.events.length > 4) this.events.shift();
      this.probe.record("event", {
        connection: this.label,
        payload_encoding: encoding,
        payload_type: frame.payloadType,
        SeqID: frame.seqId,
        LogID: frame.logId,
        service: frame.service,
        method: frame.method,
        LogIDNew: frame.logIdNew,
        headers: Object.fromEntries(
          frame.headers.map((h) => [
            h.key,
            ["sum", "seq", "biz_rt"].includes(h.key) && /^\d+$/.test(h.value) ? Number(h.value) : h.value,
          ]),
        ),
        ackSent: event.ackSent,
        ackPayload: this.ack ? { code: 200 } : null,
        envelopeConsistent: this.probe.consistent(event),
        envelope,
      });
      for (const listener of this.listeners) listener(event);
    } catch {
      this.probe.record("frame-rejected", { reason: "malformed-or-oversize" });
    }
  }
  async next(
    predicate: (e: EventRecord) => boolean,
    timeout = this.probe.timeoutMs,
    after = Date.now(),
  ): Promise<EventRecord | undefined> {
    const existing = this.events.find((e) => e.at >= after && predicate(e));
    if (existing) return existing;
    if (this.closed) return undefined;
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        this.closeListeners.delete(aborted);
        this.probe.signal.removeEventListener("abort", aborted);
      };
      const listener = (e: EventRecord) => {
        if (e.at >= after && predicate(e)) {
          cleanup();
          resolve(e);
        }
      };
      const aborted = () => {
        cleanup();
        resolve(undefined);
      };
      const timer = setTimeout(aborted, timeout);
      timer.unref();
      this.listeners.add(listener);
      this.closeListeners.add(aborted);
      this.probe.signal.addEventListener("abort", aborted, { once: true });
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.pingTimer);
    clearTimeout(this.livenessTimer);
    this.fragments.clear();
    for (const done of this.closeListeners) done();
    this.probe.sockets.delete(this);
    try {
      this.ws?.close();
    } catch {
      /* Connecting sockets can refuse close; handshake deadline still fences all handlers. */
    }
  }
}
export function isMessage(e: EventRecord): boolean {
  return e.envelope?.header?.event_type === "im.message.receive_v1";
}
export function message(e: EventRecord): any {
  return e.envelope?.event?.message ?? {};
}
export function sender(e: EventRecord): string {
  return e.envelope?.event?.sender?.sender_id?.open_id ?? "";
}
export function identityConsistent(e: EventRecord, c: Credentials): boolean {
  const h = e.envelope?.header,
    event = e.envelope?.event;
  if (h?.app_id !== c.appId || typeof h?.tenant_key !== "string" || !h.tenant_key) return false;
  return [event?.sender?.tenant_key, event?.operator?.tenant_key].every((t) => t === undefined || t === h.tenant_key);
}
export function inferTimeUnit(value: unknown, now = Date.now()): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  for (const [unit, scale] of [
    ["seconds", 1000],
    ["milliseconds", 1],
    ["microseconds", 0.001],
  ] as const)
    if (Math.abs(n * scale - now) < 24 * 3600 * 1000) return unit;
  return "unknown";
}
