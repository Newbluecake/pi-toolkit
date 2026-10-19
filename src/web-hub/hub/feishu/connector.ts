/**
 * F3: Feishu pbbp2 long connection. No hub assembly, command dispatch, business API
 * calls or dedup implementation lives here: F2 bootstraps, F1 decodes/reassembles, F6's handleEvent
 * returns ack:true ONLY after durable receipt (duplicates must cross that barrier too).
 *
 * V7: concurrent connections SPLIT events. We never dial until the old socket has
 * closed, or its bounded 5s close handover has expired. Main-session ruling
 * (2026-10-18, supersedes R2-d): native WebSocket has no terminate(). At that deadline
 * remove the open handler and retain a diagnostic-only message handler plus terminal
 * close/error cleanup until gone(); late messages are counted, NEVER dispatched/ACKed,
 * so Feishu can redeliver. Keep at most TWO abandoned sockets.
 * A third stalled closing socket blocks dials with degraded(close-timeout), until
 * a zombie closes/errors; then handover/reconnect resumes. Thus physical sockets
 * are bounded by three (two zombies + one current/closing), not R2-d's old two.
 * Injected terminate() is used when available; no Undici internals or dependencies.
 * One factory owns one installation; F8 must stop it before replacing credentials.
 */
import {
  FEISHU_ACK,
  FEISHU_CAPS,
  FEISHU_CHUNK_LIMITS,
  FEISHU_CLIENT_CONFIG_DEFAULT,
  FEISHU_SHUTDOWN_BUDGET_MS,
  FEISHU_TIMERS,
  clampClientConfig,
  isAllowedWsUrl,
  reconnectBackoffCeilingMs,
  type FeishuClientConfig,
} from "../../protocol/feishu.js";
import type { BootstrapParams, BootstrapResult, FeishuApi } from "./api.js";
import { Fragments } from "./chunks.js";
import { ackFrame, controlType, decodeFrame, encodeFrame, FrameError, header, pingFrame, type Frame } from "./frame.js";
import { systemFeishuClock, type FeishuClock } from "./http.js";
import type { FeishuInboundResult } from "./inbound.js";
import type { FeishuState } from "./state.js";

/** Structural seam, implemented by Node 22's global WebSocket (binaryType=arraybuffer). */
export interface FeishuSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  send(data: Uint8Array): void;
  close(): void;
  terminate?(): void;
}
export type FeishuConnectorStatus = "stopped" | "connecting" | "open" | "auth_failed" | "conn_limit" | "degraded";
export interface FeishuConnectorView {
  status: FeishuConnectorStatus;
  reason?: "persist-failed" | "ws-unavailable" | "undecodable-events" | "close-timeout";
  code?: number;
  gen: number;
  reconnects: number;
  config: FeishuClientConfig;
  paused: boolean;
  zombies: number;
  pending: number;
  counters: Record<string, number>;
  lastClose?: { at: number; reason: string; code?: number };
}
export interface FeishuConnectorDeps {
  credentials: Pick<BootstrapParams, "appId" | "appSecret">;
  api: Pick<FeishuApi, "bootstrap">;
  state: Pick<FeishuState, "connectorMayStart" | "commit" | "undecodable">;
  /** F8: (raw, context) => inbound.handle(raw). Signal is advisory for staging work.
   * No sends/dispatch before the durable barrier. Deadline expiry never authorizes ACK.
   * F6 owns event/message dedup and V10 stale/identity rules, not this transport. */
  handleEvent(raw: unknown, context: { signal: AbortSignal }): Promise<FeishuInboundResult>;
  clock?: FeishuClock;
  /** Monotonic clock for fragment TTLs (defaults to performance.now). */
  monotonicNow?: () => number;
  random?: () => number;
  webSocket?: (url: string) => FeishuSocket;
  /** Synchronous nonthrowing ownership transfers; F8 owns any async follow-up. No raw payload/URL/error exposed. */
  onStatus?(view: FeishuConnectorView): void;
  /** Fires once per ACKed undecodable payload with its bounded decode code; F8 debounces owner notices per code. */
  onUndecodable?(code: string): void;
}
export interface FeishuConnector {
  /** Idempotent; during stop, queue one restart after handover. Dispose cancels it. */
  start(): void;
  /** Stop reading immediately; already-admitted durable receipts may ACK for ≤1s, then close ≤5s. */
  stop(): Promise<void>;
  /** Final, immediate ACK fence, then bounded close. Idempotent. */
  dispose(): Promise<void>;
  /** F4 onHealth({persistFailed}) -> pause()/resume(). Ping/liveness stay live while paused. */
  pause(): void;
  resume(): void;
  snapshot(): FeishuConnectorView;
}
interface Connection {
  socket: FeishuSocket;
  gen: number;
  service: number;
  phase: "active" | "closing" | "zombie" | "gone";
  stalled: boolean;
  fragments: Fragments;
  timers: Set<unknown>;
  handshake?: unknown;
  ping?: unknown;
  liveness?: unknown;
  closeTimer?: unknown;
  openedAt?: number;
  message(event: { data: unknown }): void;
  open(): void;
  error(): void;
  close(event: { code?: number }): void;
  closed: Promise<void>;
  resolveClosed(): void;
}
type Bounded<T> = { kind: "ok"; value: T } | { kind: "timeout" | "aborted" | "failed" };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function createFeishuConnector(deps: FeishuConnectorDeps): FeishuConnector {
  const clock = deps.clock ?? systemFeishuClock;
  const mono = deps.monotonicNow ?? (() => performance.now());
  const random = deps.random ?? Math.random;
  const credentials = { ...deps.credentials };
  const zombies = new Set<Connection>();
  const pending = new Set<Promise<void>>();
  // Capacity follows the ACTUAL handler lifetime, not the timeout wrapper: an
  // abort-ignoring staging port must not free slots and accumulate zombie I/O.
  const inflight = new Set<object>();
  const operations = new Set<AbortController>();
  const counters: Record<string, number> = {};
  let active: Connection | undefined;
  let closing: Connection | undefined;
  let config = { ...FEISHU_CLIENT_CONFIG_DEFAULT };
  let gen = 0;
  let lifecycle = 0;
  let running = false;
  let disposed = false;
  let draining = false;
  let paused = false;
  let degradedUndecodable = false;
  let status: FeishuConnectorStatus = "stopped";
  let reason: FeishuConnectorView["reason"];
  let code: number | undefined;
  let lastClose: FeishuConnectorView["lastClose"];
  let reconnects = 0;
  let failures = 0;
  let retryTimer: unknown;
  let dialOperation: AbortController | undefined;
  let stopPromise: Promise<void> | undefined;
  let restartQueued = false;
  let disposePromise: Promise<void> | undefined;
  let pendingBytes = 0;

  function count(key: string): void {
    counters[key] = (counters[key] ?? 0) + 1;
  }
  function snapshot(): FeishuConnectorView {
    return {
      status,
      ...(reason ? { reason } : {}),
      ...(code !== undefined ? { code } : {}),
      gen,
      reconnects,
      config: { ...config },
      paused,
      zombies: zombies.size,
      pending: inflight.size,
      counters: { ...counters },
      ...(lastClose ? { lastClose: { ...lastClose } } : {}),
    };
  }
  function publish(): void {
    try {
      deps.onStatus?.(snapshot());
    } catch {
      /* observer isolation */
    }
  }
  function setStatus(s: FeishuConnectorStatus, r?: FeishuConnectorView["reason"], c?: number): void {
    status = s;
    reason = r;
    code = c;
    publish();
  }
  function openStatus(): void {
    if (!running || !active || active.phase !== "active" || active.socket.readyState !== 1) return;
    if (paused) setStatus("degraded", "persist-failed");
    else if (degradedUndecodable) setStatus("degraded", "undecodable-events");
    else setStatus("open");
  }
  function jitter(max: number): number {
    const value = random();
    return Math.floor(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5)) * max);
  }
  function clearRetry(): void {
    if (retryTimer !== undefined) clock.clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  function clearTimer(c: Connection, timer: unknown): void {
    if (timer !== undefined) {
      clock.clearTimeout(timer);
      c.timers.delete(timer);
    }
  }
  function timer(c: Connection, ms: number, fn: () => void): unknown {
    const h = clock.setTimeout(() => {
      c.timers.delete(h);
      fn();
    }, ms);
    c.timers.add(h);
    return h;
  }
  function live(c: Connection): boolean {
    return active === c && c.phase === "active" && (running || draining);
  }
  function abortOperations(): void {
    for (const op of operations) op.abort();
  }
  /** A noncooperative injected promise cannot hang the connector; late results are consumed, never ACKed. */
  function bounded<T>(
    work: (signal: AbortSignal) => Promise<T>,
    ms: number,
    controller = new AbortController(),
  ): Promise<Bounded<T>> {
    operations.add(controller);
    return new Promise((resolve) => {
      let done = false;
      const finish = (result: Bounded<T>): void => {
        if (done) return;
        done = true;
        clock.clearTimeout(h);
        controller.signal.removeEventListener("abort", aborted);
        operations.delete(controller);
        resolve(result);
      };
      const aborted = (): void => finish({ kind: "aborted" });
      const h = clock.setTimeout(() => {
        finish({ kind: "timeout" });
        controller.abort();
      }, ms);
      controller.signal.addEventListener("abort", aborted, { once: true });
      if (controller.signal.aborted) {
        aborted();
        return;
      }
      try {
        work(controller.signal).then(
          (value) => finish({ kind: "ok", value }),
          () => finish({ kind: "failed" }),
        );
      } catch {
        finish({ kind: "failed" });
      }
    });
  }
  function scheduleRetry(delay?: number): void {
    if (!running || disposed || closing || active || dialOperation || retryTimer !== undefined) return;
    const wait = delay ?? jitter(failures++ === 0 ? config.reconnectNonceMs : reconnectBackoffCeilingMs(failures - 2));
    const epoch = lifecycle;
    retryTimer = clock.setTimeout(() => {
      retryTimer = undefined;
      if (running && epoch === lifecycle) void dial();
    }, wait);
  }
  function detach(c: Connection): void {
    c.socket.removeEventListener("open", c.open);
    c.socket.removeEventListener("message", c.message);
    c.socket.removeEventListener("error", c.error);
    c.socket.removeEventListener("close", c.close);
  }
  function gone(c: Connection): void {
    if (c.phase === "gone") return;
    for (const h of c.timers) clock.clearTimeout(h);
    c.timers.clear();
    detach(c);
    c.fragments.clear();
    if (active === c) active = undefined;
    if (closing === c) closing = undefined;
    zombies.delete(c);
    c.phase = "gone";
    c.resolveClosed();
    // A third stalled handover can now occupy the freed zombie slot.
    if (closing?.stalled && zombies.size < 2) abandon(closing);
    scheduleRetry();
    publish();
  }
  function abandon(c: Connection): void {
    if (c.phase !== "closing") return;
    c.stalled = true;
    if (zombies.size >= 2) {
      if (running) setStatus("degraded", "close-timeout");
      c.resolveClosed(); // stop/dispose remain bounded even with three stalled transports
      return;
    }
    c.phase = "zombie";
    zombies.add(c);
    if (closing === c) closing = undefined;
    count("socket-abandoned");
    c.resolveClosed();
    scheduleRetry();
    publish();
  }
  function closeDeadline(c: Connection): void {
    if (c.phase !== "closing") return;
    if (c.socket.terminate) {
      try {
        c.socket.terminate();
        gone(c);
        return;
      } catch {
        count("terminate-failed");
      }
    }
    abandon(c);
  }
  function retire(c: Connection, why: string, closeCode?: number): Promise<void> {
    if (c.phase !== "active") return c.closed;
    if (c.openedAt !== undefined && clock.now() - c.openedAt >= FEISHU_TIMERS.stableResetMs) failures = 0;
    lastClose = { at: clock.now(), reason: why, ...(closeCode !== undefined ? { code: closeCode } : {}) };
    for (const h of c.timers) clock.clearTimeout(h);
    c.timers.clear();
    c.fragments.clear();
    c.phase = "closing";
    active = undefined;
    closing = c;
    if (running) setStatus("connecting");
    // Keep only diagnostic message + close/error handlers. None can decode, dispatch or ACK.
    c.socket.removeEventListener("open", c.open);
    c.closeTimer = timer(c, FEISHU_TIMERS.closeTerminateMs, () => closeDeadline(c));
    try {
      c.socket.close();
    } catch {
      count("close-failed");
    }
    if (c.socket.readyState === 3) gone(c);
    return c.closed;
  }
  function send(c: Connection, frame: Frame): boolean {
    if (!live(c) || c.socket.readyState !== 1) return false;
    if (c.socket.bufferedAmount > FEISHU_TIMERS.writeBackpressureBytes) {
      count("backpressure");
      void retire(c, "backpressure");
      return false;
    }
    try {
      c.socket.send(encodeFrame(frame));
      return true;
    } catch {
      count("write-failed");
      void retire(c, "write-failed");
      return false;
    }
  }
  function ping(c: Connection): void {
    if (!live(c) || !running) return;
    c.fragments.sweep();
    if (!send(c, pingFrame(c.service))) return;
    // Frequent pings must not postpone an already outstanding liveness deadline.
    if (c.liveness === undefined)
      c.liveness = timer(c, FEISHU_TIMERS.livenessMs, () => {
        c.liveness = undefined;
        if (live(c)) {
          count("pong-timeout");
          void retire(c, "pong-timeout");
        }
      });
    armPing(c);
  }
  function armPing(c: Connection): void {
    clearTimer(c, c.ping);
    c.ping = timer(c, config.pingIntervalMs, () => ping(c));
  }
  function pong(c: Connection, frame: Frame): void {
    if (frame.payload === undefined || frame.payload.length === 0) return;
    try {
      const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload));
      if (
        !object(raw) ||
        !["PingInterval", "ReconnectInterval", "ReconnectNonce"].some((k) => k in raw) ||
        ["PingInterval", "ReconnectInterval", "ReconnectNonce"].some(
          (k) => k in raw && (typeof raw[k] !== "number" || !Number.isFinite(raw[k])),
        )
      ) {
        count("pong-config-invalid");
        return;
      }
      config = clampClientConfig({
        PingInterval: config.pingIntervalMs / 1000,
        ReconnectInterval: config.reconnectIntervalMs / 1000,
        ReconnectNonce: config.reconnectNonceMs / 1000,
        ...raw,
      });
      count("client-config");
      armPing(c);
      publish();
    } catch {
      count("pong-config-invalid");
    }
  }
  async function undecodable(why: string): Promise<FeishuInboundResult & { code?: string }> {
    deps.state.undecodable.record({ reason: why });
    const committed = await bounded(() => deps.state.commit(), FEISHU_ACK.commitDeadlineMs);
    if (committed.kind !== "ok" || !committed.value) return { ack: false, reason: "persist-failed" };
    return { ack: true, reason: "undecodable-events", code: why };
  }
  async function receive(
    c: Connection,
    frame: Frame,
    payload: Uint8Array,
    started: number,
    release: () => void,
  ): Promise<void> {
    const result = await bounded<FeishuInboundResult & { code?: string }>((signal) => {
      const work = (async (): Promise<FeishuInboundResult & { code?: string }> => {
        if (frame.payloadEncoding) return undecodable("payload-encoding");
        let raw: unknown;
        try {
          raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
        } catch {
          return undecodable("payload-json");
        }
        if (!object(raw) || raw["schema"] !== "2.0" || !object(raw["header"]) || !object(raw["event"]))
          return undecodable("envelope-invalid");
        return deps.handleEvent(raw, { signal });
      })();
      void work.then(release, release);
      return work;
    }, FEISHU_ACK.platformBudgetMs);
    if (result.kind !== "ok") {
      count(`receive-${result.kind}`);
      return;
    }
    // Late receipt may still become durable, but its generation must never pause,
    // reconfigure or send on a successor socket (including persistence failures).
    if (!live(c)) {
      count("ack-socket-gone");
      return;
    }
    if (!result.value.ack) {
      count("receive-refused");
      if (result.value.reason === "persist-failed") pause();
      return;
    }
    if (!paused && live(c) && send(c, ackFrame(frame, clock.now() - started))) count("acked");
    else count("ack-socket-gone");
    if (result.value.reason === "duplicate") count("duplicate");
    // Benign drop classes are counters/status only — they must never page the owner.
    if (result.value.reason === "unsupported-event") count("unsupported");
    else if (result.value.reason === "stale") count("stale");
    if (result.value.reason === "undecodable-events" && running) {
      degradedUndecodable = true;
      openStatus();
      // Ownership transfer AFTER ACK; F8 owns network I/O and the debounced owner notice.
      try {
        deps.onUndecodable?.(result.value.code ?? "unknown");
      } catch {
        count("observer-failed");
      }
    }
  }
  function message(c: Connection, event: { data: unknown }): void {
    if (!live(c) || !running) {
      count(c.phase === "zombie" ? "zombie-frame" : "retired-frame");
      return;
    }
    // Any inbound frame proves liveness, even if its protobuf is malformed (SDK policy).
    clearTimer(c, c.liveness);
    c.liveness = undefined;
    count("in");
    let frame: Frame;
    try {
      frame = decodeFrame(event.data);
    } catch (error) {
      count(error instanceof FrameError ? error.code : "frame-invalid");
      return;
    }
    if (frame.method === 0) {
      if (controlType(frame) === "pong") pong(c, frame);
      else count("control-ignored");
      return;
    }
    if (frame.method !== 1 || header(frame, "type") !== "event") {
      count("ignored-type");
      return;
    }
    if (paused) {
      count("paused-frame");
      return;
    }
    const assembled = c.fragments.add(frame);
    if (assembled.status === "rejected") {
      count(assembled.reason);
      return;
    }
    if (assembled.status === "pending") return;
    if (
      inflight.size >= FEISHU_CAPS.requestsNonTerminal ||
      pendingBytes + assembled.payload.length > FEISHU_CHUNK_LIMITS.maxTotalBytes
    ) {
      count("receive-capacity");
      return;
    }
    const bytes = assembled.payload.length;
    const slot = {};
    inflight.add(slot);
    pendingBytes += bytes;
    const release = (): void => {
      if (inflight.delete(slot)) pendingBytes -= bytes;
    };
    const task = receive(c, frame, assembled.payload, clock.now(), release)
      .catch(() => {
        count("receive-failed");
      })
      .finally(() => {
        pending.delete(task);
      });
    pending.add(task);
  }
  async function dial(): Promise<void> {
    if (!running || disposed || active || closing || dialOperation) return;
    if (!deps.state.connectorMayStart()) {
      setStatus("degraded", "persist-failed");
      return;
    }
    const factory =
      deps.webSocket ??
      (typeof globalThis.WebSocket === "function" ? (url: string) => new globalThis.WebSocket(url) : undefined);
    if (!factory) {
      setStatus("degraded", "ws-unavailable");
      return;
    }
    const epoch = lifecycle;
    const controller = new AbortController();
    dialOperation = controller;
    setStatus("connecting");
    const result = await bounded(
      (signal) => deps.api.bootstrap({ ...credentials, signal, timeoutMs: FEISHU_TIMERS.bootstrapMs }),
      FEISHU_TIMERS.bootstrapMs,
      controller,
    );
    if (dialOperation === controller) dialOperation = undefined;
    if (!running || disposed || epoch !== lifecycle) return;
    if (result.kind !== "ok") {
      count(`bootstrap-${result.kind}`);
      scheduleRetry();
      return;
    }
    const endpoint: BootstrapResult = result.value;
    if (!endpoint.ok) {
      count(`bootstrap-${endpoint.class}`);
      if (endpoint.class === "auth_failed" || endpoint.class === "conn_limit") {
        setStatus(endpoint.class, undefined, endpoint.code);
        scheduleRetry(
          endpoint.class === "auth_failed" ? FEISHU_TIMERS.authFailedRetryMs : FEISHU_TIMERS.connLimitRetryMs,
        );
      } else if (endpoint.class === "refused") setStatus("degraded", "ws-unavailable", endpoint.code);
      else scheduleRetry();
      return;
    }
    // Defense in depth: even injected bootstrap ports cannot widen the WS allowlist.
    if (!isAllowedWsUrl(endpoint.data.url)) {
      count("ws-url-refused");
      setStatus("degraded", "ws-unavailable");
      return;
    }
    config = { ...endpoint.data.config };
    let socket: FeishuSocket;
    try {
      socket = factory(endpoint.data.url);
    } catch {
      count("ws-create-failed");
      scheduleRetry();
      return;
    }
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const c: Connection = {
      socket,
      gen: ++gen,
      service: endpoint.data.serviceId,
      phase: "active",
      stalled: false,
      fragments: new Fragments(mono),
      timers: new Set(),
      closed,
      resolveClosed,
      message: (event) => message(c, event),
      open: () => {
        if (!live(c) || !running) return;
        clearTimer(c, c.handshake);
        c.openedAt = clock.now();
        openStatus();
        // Match node-sdk pingLoop and the tenant-verified probe: ping on open,
        // not one full PingInterval later, and immediately arm liveness.
        ping(c);
      },
      error: () => {
        if (c.phase === "zombie" || (c.phase === "closing" && c.stalled)) gone(c);
        else if (live(c)) {
          count("ws-error");
          void retire(c, "ws-error");
        }
      },
      close: (event) => {
        if (live(c)) void retire(c, "ws-close", typeof event.code === "number" ? event.code : undefined);
        gone(c);
      },
    };
    active = c;
    if (gen > 1) reconnects++;
    socket.addEventListener("open", c.open);
    socket.addEventListener("message", c.message);
    socket.addEventListener("close", c.close);
    socket.addEventListener("error", c.error);
    try {
      socket.binaryType = "arraybuffer";
    } catch {
      count("ws-binary-mode");
      void retire(c, "ws-binary-mode");
      return;
    }
    c.handshake = timer(c, FEISHU_TIMERS.handshakeMs, () => {
      if (live(c)) {
        count("handshake-timeout");
        void retire(c, "handshake-timeout");
      }
    });
    publish();
  }
  function pause(): void {
    paused = true;
    if (running) setStatus("degraded", "persist-failed");
  }
  function resume(): void {
    if (disposed) return;
    paused = false;
    if (active?.socket.readyState === 1) openStatus();
    else if (running && !closing && !active && !dialOperation && retryTimer === undefined) {
      setStatus("connecting");
      scheduleRetry(0);
    }
  }
  function stop(immediate = false): Promise<void> {
    // A later explicit stop also cancels a start queued during an earlier stop.
    restartQueued = false;
    if (stopPromise) return stopPromise;
    running = false;
    draining = !immediate;
    lifecycle++;
    clearRetry();
    dialOperation?.abort();
    dialOperation = undefined;
    if (immediate) abortOperations();
    stopPromise = (async () => {
      if (!immediate && pending.size)
        await bounded(async () => {
          await Promise.all([...pending]);
        }, FEISHU_SHUTDOWN_BUDGET_MS.groupCommit);
      draining = false;
      abortOperations();
      const current = active ?? closing;
      if (current) await retire(current, "stopped");
      setStatus("stopped");
    })().finally(() => {
      stopPromise = undefined;
      if (restartQueued && !disposed) {
        restartQueued = false;
        start();
      }
    });
    return stopPromise;
  }
  function start(): void {
    if (running || disposed) return;
    if (stopPromise) {
      restartQueued = true;
      return;
    }
    running = true;
    lifecycle++;
    if (closing) {
      setStatus(closing.stalled ? "degraded" : "connecting", closing.stalled ? "close-timeout" : undefined);
      return;
    }
    void dial();
  }
  return {
    snapshot,
    start,
    stop: () => stop(),
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      draining = false;
      abortOperations();
      disposePromise = stop(true);
      return disposePromise;
    },
    pause,
    resume,
  };
}
