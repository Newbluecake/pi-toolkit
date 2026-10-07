/**
 * Run-transcript HTTP/SSE routes (fleet-drawer plan §5.4, package F4): the browser-facing half
 * of the subagent transcript channel. `http.ts` constructs one instance per listener (loopback
 * + LAN) via `createRouteSet`; this module owns everything below:
 *
 * - `/api/run/subscribe` (202 + directed SSE `run_history`/`run_ev`/`run_end`), `/api/run/
 *   unsubscribe` (idempotent 200), `GET /api/run/history` (paged JSON, `live` always false —
 *   the service's `page()` forces it). POSTs ride http.ts's existing CSRF/64KiB/deadline
 *   pipeline; GETs ride the session gates. Errors answer through THIS module's
 *   `RUN_HTTP_STATUS` map (§3.4: `statusFor` has no `E_UNSUPPORTED` branch and would 500) and
 *   never throw out of the handler — http.ts's dispatch stays trivial.
 * - `RunSub` generations: `subs: Map<clientId, Map<runKey, RunSub>>`; `gen` is monotonic for
 *   logs/tests only — every liveness decision is by OBJECT IDENTITY (§5.4), which is what
 *   makes "same run re-subscribed ⇒ replace with a fresh object" and "late snapshot arrives ⇒
 *   discarded" work without any refcount of in-flight snapshots.
 * - the `RunSink` the F3b service drives (`http.ts` combines the two listeners' sinks into the
 *   single `setSink` slot; refs carry `${listener}:${clientId}` so a `dropped(refs)` subset —
 *   caps re-validation — can never cross listeners, whose independent SseHub id spaces could
 *   otherwise collide on a bare clientId).
 *
 * Deviation from §5.4's letter (documented): `resyncStart` swaps EVERY current sub of the run
 * for a fresh pending object, not just live ones. Swapping a pending (subscribe-time) sub too
 * is strictly safer: its own in-flight snapshot predates the resync cause and would otherwise
 * be delivered as a stale state replacement if it landed after the round's fresh history — the
 * object-identity discard kills that race exactly the way the plan kills the re-subscribe one.
 * The fresh object carries `resync:true` (served by the round, no own snapshot started).
 *
 * Contract pins (F4 acceptance): replay drops `seq <= watermark` frames strictly; a hole
 * (first replayable seq beyond watermark+1 — generalized to any non-contiguous replayed seq)
 * is treated like `overflow` and triggers exactly ONE re-snapshot; a TERMINAL history is the
 * authoritative state and discards every buffered frame. `client.send() === false` is always a
 * no-op (the SSE layer already destroyed the connection; its `close` event runs
 * `onClientClose`, which is the single place client teardown unwatches).
 */
import type { ServerResponse } from "node:http";
import {
  RUN_ID_PATTERN,
  RUN_TX,
  RUN_TX_REASONS,
  type RunHistoryError,
  type RunHistoryPayload,
  type RunTxReason,
} from "../protocol/run-transcript.js";
import type { HubLog, ListenerKind, RegistryView, RunSink, RunTranscriptService } from "./ports.js";
import { sendJsonNegotiated } from "./gzip.js";
import { HubError } from "./registry.js";
import type { SseClient, SseEventName, SseHub } from "./sse.js";

/** §3.4's run-route status map (deliberately NOT `statusFor` — see file header). */
export function runStatusFor(code: string): number {
  switch (code) {
    case "E_BAD_REQUEST":
      return 400;
    case "E_NOT_FOUND":
      return 404;
    case "E_UNSUPPORTED":
      return 409;
    case "E_AGENT_GONE":
      return 410;
    case "E_BUSY":
      return 503;
    case "E_DEADLINE":
      return 504;
    default:
      return 500;
  }
}

/** §3.3/#3.4: run frames never enter the SSE replay ring; only the two names below are sent. */
type RunFrameEvent = Extract<SseEventName, "run_ev" | "run_end">;

interface RunFrame {
  event: RunFrameEvent;
  data: unknown;
  /** Present on `run_ev` frames (seq) — the replay watermark filter's input. */
  seq?: number;
}

interface RunSub {
  /** Monotonic per route instance; logs/tests only — liveness is by object identity. */
  readonly gen: number;
  phase: "pending" | "live";
  frames: RunFrame[];
  overflow: boolean;
  /** This pending object is served by a service resync round (armed at `resyncStart`), not by
   * an own `runTx.snapshot` — the round's settled snapshot arrives via `sink.history`. */
  resync: boolean;
  readonly agentKey: string;
  readonly runId: string;
  readonly clientId: string;
}

/** §7.1 resource cap: pending frames per sub before tail-loss (`overflow`) kicks in. */
const MAX_PENDING_FRAMES = 4_096;
/** Outer guard on `runTx.snapshot`/`page` (same shape as http.ts's HISTORY_GUARD_MS). */
const RUN_GUARD_MS = RUN_TX.reqDeadlineMs + 1_000;

const RUN_ID_RE: RegExp = new RegExp(RUN_ID_PATTERN);

function isRunId(v: string): boolean {
  return RUN_ID_RE.test(v);
}

const runKeyOf = (agentKey: string, runId: string): string => `${agentKey}|${runId}`;

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HubError("E_DEADLINE")), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function field(body: unknown, name: string): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const v = (body as Record<string, unknown>)[name];
  return typeof v === "string" && v.length > 0 && v.length <= 256 ? v : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // gzip.ts's negotiation (same exit as http.ts's sendJson — `GET /api/run/history` pages can
  // reach the same multi-hundred-KB scale as /api/history): identity stays byte-identical, a
  // ≥2 KiB body for a gzip-offering client compresses on the thread pool. SSE frames emitted by
  // this module (`client.send`) never pass through here.
  sendJsonNegotiated(res, status, body);
}

/** HTTP error body per §3.4: known codes keep their (reason) message; unknown ⇒ E_INTERNAL. */
function sendHttpError(res: ServerResponse, err: unknown, log: HubLog): void {
  if (res.headersSent || res.destroyed) return;
  if (err instanceof HubError) {
    sendJson(
      res,
      runStatusFor(err.code),
      err.message === err.code ? { error: err.code } : { error: err.code, message: err.message },
    );
    return;
  }
  log.error("web-hub run-routes: unclassified error (details suppressed from client)", { error: String(err) });
  sendJson(res, 500, { error: "E_INTERNAL" });
}

/** SSE error payload (mirrors F3b's `runErrorPayload`: reason rides only when known). */
function sseErrorPayload(agentKey: string, runId: string, err: unknown): RunHistoryError {
  const code = err instanceof HubError ? err.code : "E_DEADLINE";
  const e: RunHistoryError = { agentKey, runId, error: code as RunHistoryError["error"] };
  const msg = err instanceof Error ? err.message : undefined;
  if (msg !== undefined && (RUN_TX_REASONS as readonly string[]).includes(msg)) e.reason = msg as RunTxReason;
  return e;
}

export interface RunRoutes {
  subscribe(body: unknown, res: ServerResponse): void;
  unsubscribe(body: unknown, res: ServerResponse): void;
  historyPage(query: URLSearchParams, res: ServerResponse): Promise<void>;
  onClientClose(clientId: string): void;
  /** Hand to `runTx.setSink` (combined across listeners by http.ts). */
  sink: RunSink;
}

/** F4: combine both listeners' sinks into the one `setSink` slot the service offers. Each part
 * is invoked guarded and independently — one throwing part can never starve the other. */
export function combineRunSinks(parts: readonly RunSink[]): RunSink {
  const run = (fn: (p: RunSink) => void): void => {
    for (const p of parts) {
      try {
        fn(p);
      } catch {
        /* the service guards sink calls too; belt-and-suspenders for multi-part fan-out */
      }
    }
  };
  return {
    ev: (agentKey, runId, payload) => run((p) => p.ev(agentKey, runId, payload)),
    end: (agentKey, runId, payload) => run((p) => p.end(agentKey, runId, payload)),
    resyncStart: (agentKey, runId) => run((p) => p.resyncStart(agentKey, runId)),
    history: (agentKey, runId, payload) => run((p) => p.history(agentKey, runId, payload)),
    dropped: (agentKey, runId, err, refs) => run((p) => p.dropped(agentKey, runId, err, refs)),
  };
}

export function createRunRoutes(
  sse: SseHub,
  deps: {
    listener: ListenerKind;
    registry: RegistryView;
    runTx: RunTranscriptService;
    log: HubLog;
    isClosed: () => boolean;
    now: () => number;
  },
): RunRoutes {
  const { registry, runTx, log, listener, isClosed } = deps;
  const now = deps.now;
  const subs = new Map<string, Map<string, RunSub>>();
  let genCounter = 0;

  const refOf = (sub: RunSub): string => `${listener}:${sub.clientId}`;

  function getSub(clientId: string, key: string): RunSub | undefined {
    return subs.get(clientId)?.get(key);
  }

  /** Delete `sub` if it is still the current one; unwatch its ref only then (a replacement sub
   * owns the same ref — the superseded object must never release it). */
  function removeSub(sub: RunSub, unwatch: boolean): void {
    const key = runKeyOf(sub.agentKey, sub.runId);
    const m = subs.get(sub.clientId);
    if (m?.get(key) !== sub) return;
    m.delete(key);
    if (m.size === 0) subs.delete(sub.clientId);
    if (unwatch) runTx.unwatch(sub.agentKey, sub.runId, refOf(sub));
  }

  function buffer(sub: RunSub, frame: RunFrame): void {
    if (sub.frames.length >= MAX_PENDING_FRAMES)
      sub.overflow = true; // tail loss, keep the head
    else sub.frames.push(frame);
  }

  /** Iterate the run's current subs; dead clients are swept here (defensive — the SSE close
   * callback is the primary cleanup path). */
  function forEachSub(agentKey: string, runId: string, fn: (client: SseClient, sub: RunSub) => void): void {
    const key = runKeyOf(agentKey, runId);
    for (const [clientId, m] of [...subs]) {
      const sub = m.get(key);
      if (sub === undefined) continue;
      const client = sse.get(clientId);
      if (client === undefined) {
        removeSub(sub, true);
        continue;
      }
      fn(client, sub);
    }
  }

  // ------------------------------------------------------------- snapshot settle

  /**
   * Deliver a settled snapshot (subscribe's own pipeline, the bounded overflow/hole re-snapshot,
   * or — via `sink.history` — a service resync round) to ONE sub. Identity/`phase` rules per
   * §5.4 "snapshot 成功/失败"; replay rules per the F4 contracts (file header).
   */
  function deliverHistory(client: SseClient, sub: RunSub, payload: RunHistoryPayload, isRetry: boolean): void {
    if (!client.send("run_history", payload)) return; // SSE destroyed it; close cleanup follows
    const frames = sub.frames;
    sub.frames = [];
    if (payload.terminal) {
      // Contract: a terminal history IS the authoritative state — every buffered frame (events
      // and the pending end marker alike) is superseded by the file snapshot.
      frames.length = 0;
      sub.overflow = false;
      sub.resync = false;
      sub.phase = "live";
      return;
    }
    const watermark = payload.fromSeq - 1;
    let expected = watermark + 1;
    let hole = false;
    for (const f of frames) {
      if (f.event === "run_ev" && f.seq !== undefined) {
        if (f.seq <= watermark) continue; // strict watermark drop
        if (f.seq > expected) hole = true; // 首帧 seq > watermark+1, generalized to any gap
        expected = f.seq + 1;
      }
      // run_end always replays: it is the terminal marker (ledger-deduped upstream), and its
      // lastSeq may equal the watermark when the run ended without post-watermark events.
      if (!client.send(f.event, f.data)) return;
    }
    sub.phase = "live";
    const overflowed = sub.overflow;
    sub.resync = false;
    sub.overflow = false;
    if (!isRetry && (overflowed || hole)) {
      // §5.4: overflow / hole ⇒ exactly ONE more snapshot ("再发起一次 resync"), bounded — a
      // pathological reply can never make this loop. (The `resync` flag is NOT a trigger: it
      // only marks "this pending object is served by a round" — the round's own snapshot just
      // delivered, so re-snapshotting here would chain a fresh request per round.)
      void runSnapshot(client, sub, true);
    }
  }

  async function runSnapshot(client: SseClient, sub: RunSub, isRetry: boolean): Promise<void> {
    let payload: RunHistoryPayload | undefined;
    let err: unknown;
    try {
      payload = await withDeadline(runTx.snapshot(sub.agentKey, sub.runId, listener), RUN_GUARD_MS);
    } catch (e) {
      err = e;
    }
    const key = runKeyOf(sub.agentKey, sub.runId);
    if (getSub(sub.clientId, key) !== sub) return; // replaced/unsubscribed/cleaned: discard
    if (isClosed() || sse.get(sub.clientId) !== client) {
      removeSub(sub, true);
      return;
    }
    if (payload === undefined) {
      removeSub(sub, true);
      client.send("run_history", sseErrorPayload(sub.agentKey, sub.runId, err)); // false ⇒ no-op
      return;
    }
    deliverHistory(client, sub, payload, isRetry);
  }

  // ------------------------------------------------------------- HTTP surface

  function subscribe(body: unknown, res: ServerResponse): void {
    const clientId = field(body, "clientId");
    const agentKey = field(body, "agentKey");
    const runId = field(body, "runId");
    if (clientId === undefined || agentKey === undefined || runId === undefined || !isRunId(runId)) {
      sendJson(res, 400, { error: "E_BAD_REQUEST", message: "bad fields" });
      return;
    }
    const client = sse.get(clientId);
    if (client === undefined) {
      sendJson(res, 404, { error: "E_NOT_FOUND", message: "unknown clientId" });
      return;
    }
    if (registry.get(agentKey) === undefined) {
      sendJson(res, 404, { error: "E_NOT_FOUND", message: "unknown agentKey" });
      return;
    }
    const key = runKeyOf(agentKey, runId);
    const existing = getSub(clientId, key);
    const ref = `${listener}:${clientId}`;
    if (existing === undefined) {
      // §5.4 validation order: cap (by listener) BEFORE the per-client distinct-run budget. The
      // service's own `watch` is the authoritative cap gate (throws before mutating on
      // failure); on the budget reject below the just-added ref is rolled back so no tap
      // stays armed. A re-subscribe of a run this client already holds NEVER re-watches (§5.4
      // "不重复 watch") — the ref is still counted on the service side, so re-arming would be
      // a Set no-op anyway; skipping keeps the route's watch calls 1:1 with real arm intents.
      // The skip cannot bypass the cap gate: every server-side drop path (caps change / storm /
      // agent_down via sink.dropped, a failed round via sink.history) deletes the local sub
      // together with the service-side ref, so a re-subscribe after a cap loss finds
      // `existing === undefined` and walks the probe again; and even inside that drop's race
      // window the re-subscription's own `runTx.snapshot()` re-checks the cap — its failure
      // path sends the error frame and unwatches. Double-covered.
      try {
        runTx.watch(agentKey, runId, ref);
      } catch (err) {
        sendHttpError(res, err, log);
        return;
      }
      if ((subs.get(clientId)?.size ?? 0) >= RUN_TX.subsPerClient) {
        runTx.unwatch(agentKey, runId, ref);
        sendJson(res, 503, { error: "E_BUSY", message: "busy" });
        return;
      }
    }
    const sub: RunSub = {
      gen: ++genCounter,
      phase: "pending",
      frames: [],
      overflow: false,
      resync: false,
      agentKey,
      runId,
      clientId,
    };
    let m = subs.get(clientId);
    if (m === undefined) subs.set(clientId, (m = new Map()));
    m.set(key, sub); // same-run re-subscribe: fresh object; the old one's snapshot self-discards
    sendJson(res, 202, { ok: true });
    void runSnapshot(client, sub, false);
  }

  function unsubscribe(body: unknown, res: ServerResponse): void {
    const clientId = field(body, "clientId");
    const agentKey = field(body, "agentKey");
    const runId = field(body, "runId");
    if (clientId === undefined || agentKey === undefined || runId === undefined || !isRunId(runId)) {
      sendJson(res, 400, { error: "E_BAD_REQUEST", message: "bad fields" });
      return;
    }
    const sub = getSub(clientId, runKeyOf(agentKey, runId));
    if (sub !== undefined) removeSub(sub, true);
    sendJson(res, 200, { ok: true }); // idempotent: unknown runs also 200
  }

  async function historyPage(query: URLSearchParams, res: ServerResponse): Promise<void> {
    const agentKey = query.get("agent") ?? "";
    const runId = query.get("run") ?? "";
    const before = query.get("before") ?? "";
    const limitRaw = query.get("limit");
    if (agentKey.length === 0 || runId.length === 0 || !isRunId(runId) || before.length === 0) {
      sendJson(res, 400, { error: "E_BAD_REQUEST", message: "bad fields" });
      return;
    }
    let limit: number = RUN_TX.pageMax;
    if (limitRaw !== null) {
      if (!/^\d{1,9}$/.test(limitRaw)) {
        sendJson(res, 400, { error: "E_BAD_REQUEST", message: "bad limit" });
        return;
      }
      limit = Math.min(RUN_TX.pageMax, Math.max(1, Number(limitRaw)));
    }
    if (registry.get(agentKey) === undefined) {
      sendJson(res, 404, { error: "E_NOT_FOUND", message: "unknown agentKey" });
      return;
    }
    try {
      const payload = await withDeadline(runTx.page(agentKey, runId, before, limit, listener), RUN_GUARD_MS);
      sendJson(res, 200, payload);
    } catch (err) {
      sendHttpError(res, err, log); // {error, message: reason} per §3.4/§3.6
    }
  }

  function onClientClose(clientId: string): void {
    const m = subs.get(clientId);
    if (m === undefined) return;
    subs.delete(clientId);
    for (const sub of m.values()) runTx.unwatch(sub.agentKey, sub.runId, refOf(sub));
  }

  // ------------------------------------------------------------- RunSink

  const sink: RunSink = {
    ev(agentKey, runId, payload): void {
      forEachSub(agentKey, runId, (client, sub) => {
        if (sub.phase === "live") {
          client.send("run_ev", payload); // false ⇒ no-op by design (close cleanup follows)
          return;
        }
        buffer(sub, { event: "run_ev", data: payload, seq: payload.seq });
      });
    },
    end(agentKey, runId, payload): void {
      forEachSub(agentKey, runId, (client, sub) => {
        if (sub.phase === "live") {
          client.send("run_end", payload);
          return;
        }
        buffer(sub, { event: "run_end", data: payload });
      });
    },
    resyncStart(agentKey, runId): void {
      const key = runKeyOf(agentKey, runId);
      for (const [clientId, m] of [...subs]) {
        const sub = m.get(key);
        if (sub === undefined) continue;
        if (sse.get(clientId) === undefined) {
          removeSub(sub, true);
          continue;
        }
        // Swap EVERY current sub (live or pending — see file header) for a fresh pending object
        // served by the round; buffered frames die with the old object (the round's snapshot
        // replaces the whole client-side state).
        m.set(key, {
          gen: ++genCounter,
          phase: "pending",
          frames: [],
          overflow: false,
          resync: true,
          agentKey,
          runId,
          clientId,
        });
      }
    },
    history(agentKey, runId, payload): void {
      const key = runKeyOf(agentKey, runId);
      for (const [clientId, m] of [...subs]) {
        const sub = m.get(key);
        if (sub === undefined) continue;
        const client = sse.get(clientId);
        if (client === undefined) {
          removeSub(sub, true);
          continue;
        }
        if ("error" in payload) {
          client.send("run_history", payload); // false ⇒ no-op
          // Round failed: drop the sub and release its ref — the browser watchdog resubscribes
          // (re-arming the tap), and a drawer left closed must never leak a watched run.
          removeSub(sub, true);
          continue;
        }
        deliverHistory(client, sub, payload, false);
      }
    },
    dropped(agentKey, runId, err, refs): void {
      const key = runKeyOf(agentKey, runId);
      const targets: RunSub[] = [];
      for (const m of [...subs.values()]) {
        const sub = m.get(key);
        if (sub === undefined) continue;
        // caps-change subsets carry `${listener}:`-prefixed refs: never touch another
        // listener's subs (independent SseHub id spaces can collide on a bare clientId).
        if (refs !== undefined && !refs.includes(refOf(sub))) continue;
        targets.push(sub);
      }
      for (const sub of targets) {
        const client = sse.get(sub.clientId);
        client?.send("run_history", {
          agentKey,
          runId,
          error: err.error,
          ...(err.reason === undefined ? {} : { reason: err.reason }),
        });
        // No unwatch here: the service already reclaimed these refs (agent gone / storm /
        // caps change) — a second unwatch could release a re-armed watch's ref.
        removeSub(sub, false);
      }
    },
  };

  void now; // reserved for future log/deadline fields (frozen §5.4 signature)
  return { subscribe, unsubscribe, historyPage, onClientClose, sink };
}
