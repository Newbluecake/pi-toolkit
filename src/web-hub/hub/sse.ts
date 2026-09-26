/**
 * hub SSE fan-out (plan §包 C, 评审修订 #4).
 *
 * - One global event-id sequence; broadcast frames (`publish`) are stored in a
 *   ring of **already serialized** SSE frames, bounded by BOTH entry count
 *   (`ringSize`, 8192) and serialized bytes (`ringMaxBytes`, 16 MiB) — either
 *   limit exceeded ⇒ drop oldest.
 * - `attach` writes `hello{clientId}` first, then replays ring frames after the
 *   client's `Last-Event-ID` when that id is still covered (`>= oldest id - 1`),
 *   otherwise emits `resync`. An id from the future (hub restarted) ⇒ `resync`.
 *   A replay larger than the per-client buffer budget ⇒ `resync` instead (the
 *   client re-snapshots; cheaper than a burst that trips slow-consumer close).
 * - Directed frames (`SseClient.send`: hello/hub/agents/history/ping …) carry
 *   no `id:` field, never enter the ring and never consume an id.
 * - `publish(..., agentKey)` reaches only clients subscribed to that agent.
 * - Slow consumer: `res.writableLength > maxBufferedBytes` after a write ⇒ the
 *   client is destroyed (it reconnects and re-snapshots).
 * - Ping every `pingMs` (unref'd interval, only while clients exist).
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SSE_EVENTS, SseAuthPayload } from "../protocol/http-contract.js";

export type SseEventName = (typeof SSE_EVENTS)[number];

export interface SseClient {
  id: string;
  subscribed: Set<string>;
  send(event: SseEventName, data: unknown): boolean;
  close(): void;
  /** Set when the LAN listener attaches an authenticated client (§4.2); loopback clients never set it. */
  auth?: { sidHash: string; userId: number; epoch: number; boundOrigin: string; verifiedAt: number };
  /** Set once `revoke()` has matched this client; `publish`/`send` become no-ops for it. */
  revoked?: boolean;
}

export interface SseHub {
  attach(
    req: IncomingMessage,
    res: ServerResponse,
    lastEventId: number | undefined,
    auth?: SseClient["auth"],
  ): SseClient;
  publish(event: SseEventName, data: unknown, agentKey?: string): void; // agentKey 存在时仅推给订阅者；全局 ring（≤8192 条 且 ≤16 MiB 序列化字节，任一超限丢最旧）按 id 补发
  get(clientId: string): SseClient | undefined;
  count(): number;
  closeAll(): void;
  /** Synchronously mark matching clients revoked (stops `publish`/`send`), emit `event: auth`, then end the stream. Returns the count. */
  revoke(pred: (c: SseClient) => boolean, reason: "revoked" | "expired"): number;
  /** Snapshot of currently attached clients, for the 55s expiry-recheck tick (§4.2; LD/LS, W2). */
  list(): readonly SseClient[];
}

export const SSE_DEFAULTS = {
  ringSize: 8192,
  ringMaxBytes: 16 * 1024 * 1024,
  maxBufferedBytes: 2 * 1024 * 1024,
  pingMs: 15_000,
} as const;

interface RingEntry {
  id: number;
  frame: string;
  bytes: number;
  agentKey: string | undefined;
}

interface ClientState {
  client: SseClient;
  res: ServerResponse;
  closed: boolean;
}

/** Serialize one SSE frame. JSON.stringify never emits raw CR/LF, so `data:` is a single line. */
export function formatSseFrame(event: string, data: unknown, id?: number): string {
  const json = JSON.stringify(data === undefined ? null : data);
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${json}\n\n`;
}

export function createSseHub(opts: {
  ringSize?: number /* 8192 */;
  ringMaxBytes?: number /* 16 MiB，按已序列化 SSE 帧字节计 */;
  maxBufferedBytes?: number /* 2 MiB */;
  pingMs?: number /* 15s */;
  now: () => number;
}): SseHub {
  const ringSize = opts.ringSize ?? SSE_DEFAULTS.ringSize;
  const ringMaxBytes = opts.ringMaxBytes ?? SSE_DEFAULTS.ringMaxBytes;
  const maxBufferedBytes = opts.maxBufferedBytes ?? SSE_DEFAULTS.maxBufferedBytes;
  const pingMs = opts.pingMs ?? SSE_DEFAULTS.pingMs;
  const { now } = opts;

  // Ids start at the wall-clock ms so a restarted hub's ids are (practically)
  // never inside an old client's Last-Event-ID range.
  let lastId = Math.max(0, Math.floor(now()));
  const ring: RingEntry[] = [];
  let ringHead = 0; // index of the oldest live entry (amortized O(1) shift)
  let ringBytes = 0;
  const clients = new Map<string, ClientState>();
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  function ringLength(): number {
    return ring.length - ringHead;
  }

  function evict(): void {
    while (ringLength() > 0 && (ringLength() > ringSize || ringBytes > ringMaxBytes)) {
      const old = ring[ringHead]!;
      ringBytes -= old.bytes;
      ring[ringHead] = undefined as unknown as RingEntry; // release the frame string
      ringHead++;
    }
    if (ringHead > 1024 && ringHead * 2 > ring.length) {
      ring.splice(0, ringHead);
      ringHead = 0;
    }
  }

  function write(state: ClientState, frame: string): boolean {
    if (state.closed || state.client.revoked === true) return false;
    try {
      state.res.write(frame);
    } catch {
      drop(state, true);
      return false;
    }
    if (state.res.writableLength > maxBufferedBytes) {
      drop(state, true); // slow consumer
      return false;
    }
    return true;
  }

  function drop(state: ClientState, destroy: boolean): void {
    if (state.closed) return;
    state.closed = true;
    clients.delete(state.client.id);
    try {
      if (destroy) state.res.destroy();
      else state.res.end();
    } catch {
      /* already gone */
    }
    if (clients.size === 0) stopPing();
  }

  function startPing(): void {
    if (pingTimer !== undefined) return;
    pingTimer = setInterval(() => {
      const frame = formatSseFrame("ping", { ts: now() });
      for (const state of [...clients.values()]) write(state, frame);
    }, pingMs);
    pingTimer.unref?.();
  }

  function stopPing(): void {
    if (pingTimer === undefined) return;
    clearInterval(pingTimer);
    pingTimer = undefined;
  }

  function newClientId(): string {
    let id: string;
    do id = `c${randomBytes(12).toString("base64url")}`;
    while (clients.has(id));
    return id;
  }

  /** Frames to replay for `lastEventId`, or "resync" when the gap is not covered. */
  function replayPlan(lastEventId: number, subscribed: ReadonlySet<string>): string[] | "resync" {
    if (!Number.isFinite(lastEventId) || lastEventId > lastId) return "resync";
    if (lastEventId === lastId) return [];
    const oldest = ringLength() > 0 ? ring[ringHead]!.id : lastId + 1;
    if (lastEventId < oldest - 1) return "resync";
    const frames: string[] = [];
    let bytes = 0;
    for (let i = ringHead; i < ring.length; i++) {
      const entry = ring[i]!;
      if (entry.id <= lastEventId) continue;
      if (entry.agentKey !== undefined && !subscribed.has(entry.agentKey)) continue;
      bytes += entry.bytes;
      if (bytes > maxBufferedBytes) return "resync";
      frames.push(entry.frame);
    }
    return frames;
  }

  function attach(
    req: IncomingMessage,
    res: ServerResponse,
    lastEventId: number | undefined,
    auth?: SseClient["auth"],
  ): SseClient {
    const id = newClientId();
    const subscribed = new Set<string>();
    const client: SseClient = {
      id,
      subscribed,
      send: (event, data) => write(state, formatSseFrame(event, data)),
      close: () => drop(state, false),
      ...(auth === undefined ? {} : { auth }),
    };
    const state: ClientState = { client, res, closed: false };
    clients.set(id, state);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    req.socket.setNoDelay(true);
    const onGone = (): void => drop(state, false);
    res.on("close", onGone);
    res.on("error", onGone);
    req.on("error", onGone);

    write(state, formatSseFrame("hello", { clientId: id }));
    if (lastEventId !== undefined) {
      const plan = replayPlan(lastEventId, subscribed);
      if (plan === "resync") write(state, formatSseFrame("resync", { lastEventId, currentId: lastId }));
      else for (const frame of plan) if (!write(state, frame)) break;
    }
    if (!state.closed) startPing();
    return client;
  }

  function publish(event: SseEventName, data: unknown, agentKey?: string): void {
    const id = ++lastId;
    const frame = formatSseFrame(event, data, id);
    const bytes = Buffer.byteLength(frame, "utf8");
    ring.push({ id, frame, bytes, agentKey });
    ringBytes += bytes;
    evict();
    for (const state of [...clients.values()]) {
      if (agentKey !== undefined && !state.client.subscribed.has(agentKey)) continue;
      write(state, frame);
    }
  }

  function revoke(pred: (c: SseClient) => boolean, reason: "revoked" | "expired"): number {
    const payload: SseAuthPayload = { reason };
    const frame = formatSseFrame("auth", payload);
    let n = 0;
    for (const state of [...clients.values()]) {
      if (state.closed || state.client.revoked === true || !pred(state.client)) continue;
      state.client.revoked = true; // stop publish/send before anything else observes this client
      n++;
      try {
        state.res.write(frame);
      } catch {
        // best effort — falling through to drop() below regardless
      }
      drop(state, false);
    }
    return n;
  }

  return {
    attach,
    publish,
    get: (clientId) => clients.get(clientId)?.client,
    count: () => clients.size,
    revoke,
    list: () => [...clients.values()].filter((s) => !s.closed).map((s) => s.client),
    closeAll: () => {
      for (const state of [...clients.values()]) drop(state, false);
      stopPing();
    },
  };
}
