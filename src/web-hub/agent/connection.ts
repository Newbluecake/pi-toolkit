/**
 * agent → hub connection (plan §包 D — connection.ts; arch §3.2 / §4.1).
 *
 * Zero-hang contract: every public method is synchronous, never throws and never
 * awaits. Network I/O is asynchronous, every socket and timer is unref'd, and
 * every wait has a deadline (connect 1s, hello_ack 2s, 30s silence, backoff).
 *
 * Backpressure (plan §9 revision #1 — memory is bounded):
 *  - only the `live` link writes to the socket; in any other state `session /
 *    status / fleet / prompts` go to overwrite-only slots (one frame each) and
 *    `ev` frames are dropped (their seq still advances and is remembered as
 *    `gapFrom`); entering `live` replays the slots, then `gap{fromSeq}`;
 *  - socket close/error ⇒ the socket (and its write buffer) is dropped at once,
 *    seq never rewinds, `gapFrom` is recorded, the link goes to backoff;
 *  - live soft cap (`LIMITS.writeQueueBytes`, 1 MiB): droppable frames are
 *    discarded (gap sent after `drain`); non-droppable frames are still written;
 *  - live hard cap (`LIMITS.hardQueueBytes`, 4 MiB): destroy + clear + gap +
 *    backoff. Resident buffer ≤ 4 MiB + one frame.
 *
 * Lifetime (spike K4): two process-level globals —
 *  - `Symbol.for("pi-subagent:web-hub:agent-id")`: `{pid, nonce}` plain data,
 *    created once per process, read-only afterwards;
 *  - `Symbol.for("pi-subagent:web-hub")`: the current HubConnection (module
 *    instance level, identity-checked release).
 * `implVersion = buildId#MODULE_INSTANCE`: same module instance (`/new`,
 * `/resume`, `/fork`) ⇒ reuse the socket; a re-evaluated module (`/reload`) ⇒
 * the old instance says `bye{handover}` and a new one reconnects with the same
 * agentId and a new epoch.
 */
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { connect as netConnectDefault, type Socket } from "node:net";
import type { AgentFrame, AgentId, AgentKind, HubFrame, SessionInfo } from "../protocol/messages.js";
import { decodeHubFrame, LIMITS, TIMING } from "../protocol/messages.js";
import { encodeFrame, NdjsonDecoder } from "../protocol/ndjson.js";
import type { HubPaths } from "../protocol/paths.js";
import { P1_CAPS, PROTO, protoCompatible } from "../protocol/version.js";
import type { WebHubSettings, WebHubStatusView } from "./index.js";
import { type LauncherPlan, shouldSpawnHub } from "./launcher.js";

/** Module-scope constant: differs on every module evaluation (spike K4: every `/reload`). */
export const MODULE_INSTANCE: string = randomUUID();

const AGENT_ID_KEY = Symbol.for("pi-subagent:web-hub:agent-id");
const CONN_KEY = Symbol.for("pi-subagent:web-hub");

/** Retry delay after `hello_reject{E_PROTO}` (arch §4.3: retry in 10 min). */
const PROTO_RETRY_MS = 10 * 60_000;
/** After a graceful `end()`, force-destroy a socket whose peer never reads. */
const END_DESTROY_MS = 1_000;
const BACKOFF_JITTER = 0.2;
const SPAWN_FAST_MIN_MS = 250;
const SPAWN_FAST_MAX_MS = 4_000;

type GlobalBag = Record<symbol, unknown>;

/** Read (or create on first use) the process-level agent identity. */
export function processAgentId(): AgentId {
  const g = globalThis as GlobalBag;
  const v = g[AGENT_ID_KEY];
  if (isAgentId(v) && v.pid === process.pid) return v;
  const id: AgentId = Object.freeze({ pid: process.pid, nonce: randomBytes(16).toString("base64url") });
  g[AGENT_ID_KEY] = id;
  return id;
}

function isAgentId(v: unknown): v is AgentId {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.pid === "number" && typeof o.nonce === "string";
}

export interface BindingPort {
  onSnapshotReq(rid: string): void;
  onBranchReq(rid: string, maxBytes: number): void;
  onStateChange(v: WebHubStatusView): void;
}

export interface HubConnection {
  readonly implVersion: string; // = `${buildId}#${MODULE_INSTANCE}`
  attach(binding: BindingPort, session: SessionInfo): void;
  detach(reason: "quit" | "reload" | "new" | "resume" | "fork"): void;
  send(frame: AgentFrame, opts?: { droppable?: boolean }): void;
  setSlot(kind: SlotKind, frame: AgentFrame): void;
  readonly bufferedBytes: number;
  nextSeq(): number;
  readonly seq: number;
  status(): WebHubStatusView;
  close(reason: string): void;
}

export type SlotKind = "session" | "status" | "fleet" | "prompts";
const SLOT_ORDER: readonly SlotKind[] = ["session", "status", "fleet", "prompts"];

export interface AcquireOptions {
  buildId: string;
  pluginVersion: string;
  kind: AgentKind;
  cwd: string;
  paths: HubPaths;
  settings: WebHubSettings;
  launcher: LauncherPlan | { error: string };
  now: () => number;
  netConnect?: typeof import("node:net").connect;
  /** `PI_WEBHUB_HEADLESS=1`: never spawn a hub (arch §5.3). */
  headless?: boolean;
  /** Fire-and-forget hub spawn (wired to `spawnHub`); gated here by `shouldSpawnHub`. */
  spawn?: () => void;
  /** Jitter source (tests). */
  random?: () => number;
}

/**
 * Get the process's HubConnection: reuse the global one when its implVersion
 * matches (same module instance), otherwise hand the old one over
 * (`bye{handover}` + close) and create a new one (same agentId, new epoch).
 */
export function acquireConnection(opts: AcquireOptions): HubConnection {
  const g = globalThis as GlobalBag;
  const implVersion = `${opts.buildId}#${MODULE_INSTANCE}`;
  const existing = g[CONN_KEY];
  let inheritedSpawnAt: number | undefined;
  if (isConnectionLike(existing)) {
    if (existing.implVersion === implVersion && safeState(existing) !== "off") return existing;
    const at = (existing as { lastSpawnAt?: unknown }).lastSpawnAt;
    if (typeof at === "number") inheritedSpawnAt = at;
    try {
      existing.close("handover");
    } catch {
      /* a foreign/older instance misbehaving must not block the new one */
    }
  }
  const conn = new Connection(implVersion, opts, inheritedSpawnAt);
  g[CONN_KEY] = conn;
  conn.start();
  return conn;
}

/** Identity-checked release: an old instance never deletes its successor. */
export function releaseConnection(conn: HubConnection): void {
  const g = globalThis as GlobalBag;
  if (g[CONN_KEY] === conn) delete g[CONN_KEY];
}

/** The process's current connection, if any (read-only peek). */
export function currentConnection(): HubConnection | undefined {
  const v = (globalThis as GlobalBag)[CONN_KEY];
  return isConnectionLike(v) ? v : undefined;
}

function isConnectionLike(v: unknown): v is HubConnection {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.implVersion === "string" && typeof o.close === "function" && typeof o.status === "function";
}

function safeState(c: HubConnection): WebHubStatusView["state"] {
  try {
    return c.status().state;
  } catch {
    return "off";
  }
}

type LinkState = "idle" | "connecting" | "handshaking" | "live" | "backoff" | "closed";

function unrefTimer(ms: number, fn: () => void): NodeJS.Timeout {
  const t = setTimeout(fn, ms);
  t.unref();
  return t;
}

function errCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

class Connection implements HubConnection {
  readonly implVersion: string;
  lastSpawnAt: number | undefined;

  private readonly opts: AcquireOptions;
  private readonly connectImpl: typeof import("node:net").connect;
  private link: LinkState = "idle";
  private socket: Socket | undefined;
  private readonly slots = new Map<SlotKind, AgentFrame>();
  private seqValue = 0;
  private gapFrom: number | undefined;
  private firstEvSeqOnLink: number | undefined;
  private binding: BindingPort | undefined;

  private connectTimer: NodeJS.Timeout | undefined;
  private helloTimer: NodeJS.Timeout | undefined;
  private silenceTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private graceTimer: NodeJS.Timeout | undefined;

  private attempt = 0;
  private fastAttempt = 0;
  private spawnWindowUntil = 0;
  private noHub = false;
  private protoRejected = false;
  private agentKey: string | undefined;
  private hubVersion: string | undefined;
  private httpPort: number | undefined;
  private lastError: string | undefined;
  private lastViewKey = "";

  constructor(implVersion: string, opts: AcquireOptions, lastSpawnAt: number | undefined) {
    this.implVersion = implVersion;
    this.opts = opts;
    this.connectImpl = opts.netConnect ?? netConnectDefault;
    this.lastSpawnAt = lastSpawnAt;
  }

  // ---------------------------------------------------------------- public API

  get seq(): number {
    return this.seqValue;
  }

  get bufferedBytes(): number {
    return this.socket?.writableLength ?? 0;
  }

  nextSeq(): number {
    this.seqValue += 1;
    return this.seqValue;
  }

  start(): void {
    if (this.link === "idle") this.connectNow();
  }

  attach(binding: BindingPort, session: SessionInfo): void {
    if (this.link === "closed") return;
    this.clearTimer("graceTimer");
    this.binding = binding;
    this.setSlot("session", { t: "session", ...session });
    this.notify(true);
  }

  detach(reason: "quit" | "reload" | "new" | "resume" | "fork"): void {
    if (this.link === "closed") return;
    this.binding = undefined;
    if (reason === "quit") {
      this.close("quit");
      releaseConnection(this);
      return;
    }
    this.setSlot("session", { t: "session_detached", reason });
    this.clearTimer("graceTimer");
    this.graceTimer = unrefTimer(TIMING.detachGraceMs, () => {
      this.graceTimer = undefined;
      this.close("detach-timeout");
      releaseConnection(this);
    });
  }

  send(frame: AgentFrame, opts?: { droppable?: boolean }): void {
    try {
      const isEv = frame.t === "ev";
      if (this.link !== "live" || this.socket === undefined) {
        if (isEv) this.markGap(frame.seq);
        return;
      }
      if (opts?.droppable === true && this.bufferedBytes > LIMITS.writeQueueBytes) {
        if (isEv) this.markGap(frame.seq);
        return;
      }
      if (isEv && this.firstEvSeqOnLink === undefined) this.firstEvSeqOnLink = frame.seq;
      this.writeRaw(frame);
    } catch {
      /* never throw into a pi event handler */
    }
  }

  setSlot(kind: SlotKind, frame: AgentFrame): void {
    try {
      this.slots.set(kind, frame);
      if (this.link === "live") this.writeRaw(frame);
    } catch {
      /* never throw */
    }
  }

  status(): WebHubStatusView {
    const view: WebHubStatusView = { state: this.viewState(), attached: this.binding !== undefined };
    if (this.agentKey !== undefined) view.agentKey = this.agentKey;
    if (this.hubVersion !== undefined) view.hubVersion = this.hubVersion;
    if (this.link === "live" && this.httpPort !== undefined) view.httpPort = this.httpPort;
    if (this.lastError !== undefined) view.lastError = this.lastError;
    return view;
  }

  close(reason: string): void {
    if (this.link === "closed") return;
    const sock = this.socket;
    const wasLive = this.link === "live";
    this.link = "closed";
    this.socket = undefined;
    for (const k of TIMER_KEYS) this.clearTimer(k);
    this.slots.clear();
    if (sock !== undefined) {
      try {
        if (wasLive) {
          sock.write(encodeFrame({ t: "bye", reason }));
          sock.end();
          // A peer that never reads (kill -STOP) must not pin the socket forever.
          unrefTimer(END_DESTROY_MS, () => sock.destroy());
        } else {
          sock.destroy();
        }
      } catch {
        sock.destroy();
      }
    }
    this.notify(true);
    this.binding = undefined;
  }

  // ------------------------------------------------------------- link machine

  private connectNow(): void {
    if (this.link === "closed") return;
    this.clearTimer("retryTimer");
    this.link = "connecting";
    this.notify();
    let sock: Socket;
    try {
      sock = this.connectImpl({ path: this.opts.paths.socketPath });
    } catch (err) {
      this.linkDown(errCode(err) ?? "ECONNECT", String(err));
      return;
    }
    this.socket = sock;
    this.firstEvSeqOnLink = undefined;
    try {
      sock.unref();
    } catch {
      /* fake sockets */
    }
    const decoder = new NdjsonDecoder({
      onFrame: (raw) => this.onRaw(sock, raw),
      onError: (e) => {
        if (e.code === "E_FRAME_TOO_LARGE") this.onSocketDown(sock, "E_FRAME_TOO_LARGE", "hub frame too large");
      },
    });
    this.connectTimer = unrefTimer(TIMING.connectMs, () => {
      this.connectTimer = undefined;
      this.onSocketDown(sock, "ETIMEDOUT", "connect timeout");
    });
    sock.once("connect", () => {
      if (this.socket !== sock) return;
      this.clearTimer("connectTimer");
      this.link = "handshaking";
      this.noHub = false;
      this.writeRaw(this.hello());
      this.helloTimer = unrefTimer(TIMING.helloAckMs, () => {
        this.helloTimer = undefined;
        this.onSocketDown(sock, "E_HELLO_TIMEOUT", "hello_ack timeout");
      });
      this.notify();
    });
    sock.on("data", (chunk: Buffer | string) => {
      if (this.socket === sock) decoder.push(chunk);
    });
    sock.on("drain", () => this.onDrain(sock));
    sock.on("error", (err: unknown) => this.onSocketDown(sock, errCode(err) ?? "EIO", String(err)));
    sock.on("close", () => this.onSocketDown(sock, "ECLOSED", "socket closed"));
  }

  private hello(): AgentFrame {
    const launcher: [string, string] =
      "error" in this.opts.launcher
        ? [process.execPath, process.argv[1] ?? ""]
        : [this.opts.launcher.execPath, this.opts.launcher.argv1];
    return {
      t: "hello",
      proto: { major: PROTO.major, minor: PROTO.minor },
      pluginVersion: this.opts.pluginVersion,
      buildId: this.opts.buildId,
      agentId: processAgentId(),
      epoch: MODULE_INSTANCE,
      kind: this.opts.kind,
      launcher,
      cwd: this.opts.cwd,
      caps: [...P1_CAPS],
    };
  }

  private onRaw(sock: Socket, raw: unknown): void {
    if (this.socket !== sock) return;
    this.silenceTimer?.refresh();
    const frame = decodeHubFrame(raw);
    if (frame === undefined) return;
    this.onFrame(sock, frame);
  }

  private onFrame(sock: Socket, frame: HubFrame): void {
    switch (frame.t) {
      case "hello_ack": {
        if (this.link !== "handshaking") return;
        if (!protoCompatible(frame.proto)) {
          this.reject(`E_PROTO: hub proto ${frame.proto.major}.${frame.proto.minor}`, PROTO_RETRY_MS, true);
          return;
        }
        this.clearTimer("helloTimer");
        this.link = "live";
        this.agentKey = frame.agentKey;
        this.hubVersion = frame.hubVersion;
        this.httpPort = frame.http.port;
        this.lastError = undefined;
        this.protoRejected = false;
        this.attempt = 0;
        this.fastAttempt = 0;
        this.spawnWindowUntil = 0;
        this.silenceTimer = unrefTimer(TIMING.silenceMs, () => {
          this.silenceTimer = undefined;
          this.onSocketDown(sock, "E_SILENCE", "hub silent for 30s");
        });
        this.pingTimer = setInterval(() => {
          if (this.link === "live") this.writeRaw({ t: "ping", ts: this.opts.now() });
        }, TIMING.pingMs);
        this.pingTimer.unref();
        for (const kind of SLOT_ORDER) {
          const slot = this.slots.get(kind);
          if (slot !== undefined && this.socket === sock) this.writeRaw(slot);
        }
        this.flushGap();
        this.notify();
        return;
      }
      case "hello_reject": {
        if (this.link !== "handshaking") return;
        const proto = frame.code === "E_PROTO";
        const delay = proto
          ? Math.max(frame.retryAfterMs, PROTO_RETRY_MS)
          : Math.max(frame.retryAfterMs, this.backoffDelay());
        this.reject(`${frame.code}: ${frame.message}`, delay, proto);
        return;
      }
      case "ping":
        if (this.link === "live") this.writeRaw({ t: "pong", ts: frame.ts });
        return;
      case "pong":
        return;
      case "snapshot_req":
        if (this.link === "live") this.callBinding((b) => b.onSnapshotReq(frame.rid));
        return;
      case "branch_req":
        if (this.link === "live") this.callBinding((b) => b.onBranchReq(frame.rid, frame.maxBytes));
        return;
    }
  }

  private reject(message: string, delayMs: number, proto: boolean): void {
    this.lastError = message;
    this.protoRejected = proto;
    this.teardownSocket();
    this.enterBackoff(delayMs);
  }

  private onDrain(sock: Socket): void {
    if (this.socket !== sock || this.link !== "live") return;
    if (this.bufferedBytes <= LIMITS.writeQueueBytes) this.flushGap();
  }

  private flushGap(): void {
    if (this.gapFrom === undefined || this.link !== "live") return;
    const fromSeq = this.gapFrom;
    this.gapFrom = undefined;
    this.writeRaw({ t: "gap", fromSeq });
  }

  private markGap(seq: number): void {
    if (this.gapFrom === undefined || seq < this.gapFrom) this.gapFrom = seq;
  }

  /** Write one frame to the current socket; enforces the 4 MiB hard cap. */
  private writeRaw(frame: AgentFrame): void {
    const sock = this.socket;
    if (sock === undefined) return;
    let line: string;
    try {
      line = encodeFrame(frame);
    } catch {
      return; // unserializable payload: drop, never throw
    }
    try {
      sock.write(line);
    } catch (err) {
      this.onSocketDown(sock, errCode(err) ?? "EWRITE", String(err));
      return;
    }
    if (this.socket === sock && sock.writableLength > LIMITS.hardQueueBytes) {
      this.onSocketDown(sock, "E_BACKPRESSURE", "write queue over 4 MiB");
    }
  }

  private onSocketDown(sock: Socket, code: string, message: string): void {
    if (this.socket !== sock || this.link === "closed") return;
    const wasConnecting = this.link === "connecting";
    this.lastError = `${code}: ${message}`;
    this.teardownSocket();
    this.linkDownAfterTeardown(wasConnecting ? code : undefined);
  }

  private linkDown(code: string, message: string): void {
    this.lastError = `${code}: ${message}`;
    this.teardownSocket();
    this.linkDownAfterTeardown(code);
  }

  /** Drop the socket and everything buffered on it; seq never rewinds. */
  private teardownSocket(): void {
    const sock = this.socket;
    this.socket = undefined;
    for (const k of LINK_TIMER_KEYS) this.clearTimer(k);
    if (this.firstEvSeqOnLink !== undefined) this.markGap(this.firstEvSeqOnLink);
    this.firstEvSeqOnLink = undefined;
    if (sock !== undefined) {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  /** `connectCode` is set only when the failure happened before the socket connected. */
  private linkDownAfterTeardown(connectCode: string | undefined): void {
    if (this.link === "closed") return;
    this.noHub = connectCode === "ENOENT" || connectCode === "ECONNREFUSED";
    const now = this.opts.now();
    if (this.noHub && this.maybeSpawn(now)) {
      this.enterBackoff(this.fastDelay());
      return;
    }
    if (now < this.spawnWindowUntil) {
      this.enterBackoff(this.fastDelay());
      return;
    }
    this.enterBackoff(this.backoffDelay());
  }

  private maybeSpawn(now: number): boolean {
    const spawn = this.opts.spawn;
    if (spawn === undefined) return false;
    const ok = shouldSpawnHub({
      autoStart: this.opts.settings.autoStart,
      headless: this.opts.headless === true,
      launcherOk: !("error" in this.opts.launcher),
      lastSpawnAt: this.lastSpawnAt,
      now,
    });
    if (!ok) return false;
    this.lastSpawnAt = now;
    this.spawnWindowUntil = now + TIMING.spawnWindowMs;
    this.fastAttempt = 0;
    try {
      spawn();
    } catch {
      /* spawn is fire-and-forget */
    }
    return true;
  }

  private fastDelay(): number {
    const d = Math.min(SPAWN_FAST_MIN_MS * 2 ** this.fastAttempt, SPAWN_FAST_MAX_MS);
    this.fastAttempt += 1;
    return d;
  }

  /** Exponential backoff 0.5s → 30s cap, ±20% jitter. */
  private backoffDelay(): number {
    const base = Math.min(TIMING.backoffMaxMs, TIMING.backoffMinMs * 2 ** this.attempt);
    this.attempt += 1;
    const r = (this.opts.random ?? Math.random)();
    return Math.round(base * (1 + (r * 2 - 1) * BACKOFF_JITTER));
  }

  private enterBackoff(delayMs: number): void {
    if (this.link === "closed") return;
    this.link = "backoff";
    this.clearTimer("retryTimer");
    this.retryTimer = unrefTimer(delayMs, () => {
      this.retryTimer = undefined;
      this.connectNow();
    });
    this.notify();
  }

  // ------------------------------------------------------------------ helpers

  private viewState(): WebHubStatusView["state"] {
    switch (this.link) {
      case "idle":
      case "closed":
        return "off";
      case "connecting":
      case "handshaking":
        return "connecting";
      case "live":
        return "live";
      case "backoff":
        if (this.protoRejected) return "proto";
        if (
          this.noHub &&
          "error" in this.opts.launcher &&
          this.opts.settings.autoStart &&
          this.opts.headless !== true
        ) {
          return "loader";
        }
        return "backoff";
    }
  }

  private notify(force = false): void {
    const b = this.binding;
    if (b === undefined) return;
    const view = this.status();
    const key = JSON.stringify(view);
    if (!force && key === this.lastViewKey) return;
    this.lastViewKey = key;
    try {
      b.onStateChange(view);
    } catch {
      /* binding errors never reach the socket machinery */
    }
  }

  private callBinding(fn: (b: BindingPort) => void): void {
    const b = this.binding;
    if (b === undefined) return;
    try {
      fn(b);
    } catch {
      /* a stale ctx throwing must not kill the link */
    }
  }

  private clearTimer(key: TimerKey): void {
    const t = this[key];
    if (t !== undefined) {
      clearTimeout(t);
      this[key] = undefined;
    }
  }
}

type TimerKey = "connectTimer" | "helloTimer" | "silenceTimer" | "pingTimer" | "retryTimer" | "graceTimer";
const LINK_TIMER_KEYS: readonly TimerKey[] = ["connectTimer", "helloTimer", "silenceTimer", "pingTimer"];
const TIMER_KEYS: readonly TimerKey[] = [...LINK_TIMER_KEYS, "retryTimer", "graceTimer"];
