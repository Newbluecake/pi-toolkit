/**
 * Run transcript service (fleet-drawer plan §5.2, package F3b): the hub-side half of the
 * subagent transcript channel. Owns everything below the HTTP face —
 *
 * - `requireCap` (#4, §7.1): `snapshot`/`page`/`watch` all re-check the agent's live hello caps
 *   by listener (`runtx.v1` for loopback, plus `runtx.lan.v1` for LAN) via `registry.getCaps`,
 *   never the UX-only `AgentCard.runTranscript*`; a caps change (re-hello) re-validates every
 *   held ref and drops the ones that no longer qualify (§5.2 "caps 变化 ⇒ 回收不再合格的订阅").
 * - watch reference counting (§5.2): `Map<agentKey|runId, {refs:Set<ref>}>`, ref =
 *   `${listener}:${clientId}` (listener parsed from the prefix); 0→1 sends `run_watch{on:true}`
 *   exactly once (unless the RunEndLedger already holds a terminal record for the run), 1→0
 *   sends `{on:false}` and deletes the watch. Duplicate refs never double-count.
 * - snapshot order (§5.2): callers must `watch()` BEFORE `snapshot()` so the same socket sees
 *   `run_watch` ahead of `run_tx_req` and the tap exists when the snapshot runs; the service
 *   itself never auto-watches.
 * - reply branches: `source:"live"` assembles the payload directly; `source:"file"` routes
 *   through F3a's `run-file-reader` walking the agent-reported `finalLeafId` (§3.6's frozen
 *   reason vocabulary maps onto `HubError` codes here — 409 semantics are F4's layer);
 *   `ok:false` maps 1:1. `sessionFile`/`finalLeafId` never survive onto a payload.
 * - §3.3 hub state table: per-watch `{tapId, lastSeq, contiguous, ended}` with the resync
 *   single-flight (`again` coalescing, 10s/3-round storm breaker ⇒ `E_BUSY`+`resync_storm`),
 *   plus the RunEndLedger (#2: LRU 256 / TTL 15min — `run_end` dedupe and the
 *   "(re)subscribe ⇒ terminal snapshot without re-watching" shortcut).
 * - bus reactions (§5.2): `agent_down` ⇒ every held subscription gets `E_AGENT_GONE`;
 *   `gap{fromSeq:0}` (registry epoch change) or a `session` frame changing sessionId ⇒ re-arm
 *   `run_watch{on:true}` and resync every watch of that agent; `caps` ⇒ re-validate refs.
 *
 * The service never touches SSE: fan-out goes through the injected `RunSink` (§5.2 `setSink`,
 * loopback and LAN each hand in one; refs carry the listener so cap re-validation knows which
 * subscriptions a cap loss invalidates). All sink invocations are exception-guarded.
 *
 * No timers: the ledger TTL and the resync storm window are evaluated lazily against the
 * injected clock, so nothing here can wedge a print-mode process.
 */
import { Buffer } from "node:buffer";
import type { AgentFrame, HubFrame, WireEntry } from "../protocol/messages.js";
import {
  RUN_TX,
  RUN_TX_REASONS,
  type RunEndFrame,
  type RunEvFrame,
  type RunGapFrame,
  type RunHistoryError,
  type RunHistoryPayload,
  type RunTxReplyFrame,
  type RunTxReason,
} from "../protocol/run-transcript.js";
import type { HubBus, HubLog, ListenerKind, RunSink, RunTranscriptService } from "./ports.js";
import { HubError } from "./registry.js";
import type { RunFileReader } from "./run-file-reader.js";
import { formatSseFrame } from "./sse.js";

/** §3.3 storm window: more than `RUN_TX.resyncMaxPer10s` round STARTS within this window ⇒ breaker. */
const RESYNC_WINDOW_MS = 10_000;

/** §3.1: `run_history` is the SSE event every snapshot-shaped payload rides. */
const RUN_HISTORY_EVENT = "run_history";

interface RunWatchState {
  readonly agentKey: string;
  readonly runId: string;
  /** `${listener}:${clientId}` per subscriber; cap re-validation reads the prefix. */
  readonly refs: Set<string>;
  /** Whether `run_watch{on:true}` was sent (and not turned off) for this watch. */
  watchOn: boolean;
  tapId: string | undefined;
  lastSeq: number;
  contiguous: boolean;
  ended: { tapId: string; lastSeq: number; status: string } | undefined;
  resync: {
    inFlight: boolean;
    /** Re-arm cause "end": a run_end arrived mid-round (the next snapshot takes the file path).
     * Cleared by a terminal settle — a terminal snapshot IS the end's answer. */
    again: boolean;
    /** Re-arm cause "epoch/session" (P1-2 round 2): resyncAll armed a fresh round while one
     * was in flight. NOT cleared by a terminal settle — the settled snapshot predates the
     * epoch/session change and cannot serve as the post-change authority (S8), so this cause
     * survives even a terminal settle and opens its round through the normal storm budget. */
    againEpoch: boolean;
    times: number[];
    maxGapFromSeq: number | undefined;
  };
}

interface LedgerEntry {
  tapId: string;
  lastSeq: number;
  status: string;
  at: number;
}

/** §3.6 mapping of the reader's failure vocabulary onto `HubError` codes (HTTP status is F4's). */
function readerHubError(reason: "file_missing" | "leaf_missing" | "too_large" | "parse_error" | "busy"): HubError {
  switch (reason) {
    case "file_missing":
    case "leaf_missing":
      return new HubError("E_NOT_FOUND", reason);
    case "too_large":
    case "parse_error":
      return new HubError("E_UNSUPPORTED", reason);
    case "busy":
      return new HubError("E_BUSY", reason);
  }
}

function asHubError(err: unknown): HubError {
  return err instanceof HubError ? err : new HubError("E_DEADLINE", String(err));
}

function runErrorPayload(agentKey: string, runId: string, err: HubError): RunHistoryError {
  const e: RunHistoryError = { agentKey, runId, error: err.code as RunHistoryError["error"] };
  if ((RUN_TX_REASONS as readonly string[]).includes(err.message)) e.reason = err.message as RunTxReason;
  return e;
}

const runKey = (agentKey: string, runId: string): string => `${agentKey}|${runId}`;

/**
 * P2-4 (验收修补 #4): the service's ACTUAL registry surface, with `getCaps` REQUIRED.
 * `Registry` satisfies this structurally (as does any narrow test double that provides exactly
 * these four members). Why required rather than the optional `RegistryView.getCaps`: admission
 * must fail CLOSED on a caps answer it cannot distinguish — with the method optional, a
 * provider that simply lacks it would make `requireCap` read "caps unknown" as "agent absent"
 * (E_NOT_FOUND) instead of a provider defect; typed as required, `undefined` can ONLY mean the
 * agent is not in the registry, which is exactly the E_NOT_FOUND semantic we keep.
 */
export interface RunTxRegistryPort {
  getCaps(agentKey: string): readonly string[] | undefined;
  send(agentKey: string, frame: HubFrame): boolean;
  request<R extends AgentFrame>(agentKey: string, frame: HubFrame & { rid: string }, deadlineMs: number): Promise<R>;
  bus: HubBus;
}

/**
 * §5.2: ref = `${listener}:${clientId}` — the prefix IS the listener that owns the subscription.
 * Strict shape (P2-3): a colon with a non-empty valid prefix AND a non-empty remainder —
 * `lanish:`/`loopbackX:` (bad prefix), `loopback`/`lan` (no colon), `""`/`:c1` (empty prefix) and
 * `loopback:` (empty clientId) are all refused rather than guessed.
 */
function listenerOfRef(ref: string): ListenerKind {
  const idx = ref.indexOf(":");
  if (idx <= 0 || idx === ref.length - 1) throw new HubError("E_BAD_REQUEST", "bad ref");
  const head = ref.slice(0, idx);
  if (head === "loopback" || head === "lan") return head;
  throw new HubError("E_BAD_REQUEST", "bad ref");
}

/**
 * §5.2 `capRunPayload`: trim `entries` (oldest-first) so the ACTUAL wire unit fits `maxBytes` —
 * same two-pass shape as `history.ts`'s `buildCappedHistoryPayload` (cheap per-entry sum first,
 * then a loop over the real frame string), with `build`/`frame` call-site-supplied because a
 * snapshot rides an SSE frame while a page rides a bare JSON body. Always keeps the newest entry.
 */
function capRunPayload(
  entries: readonly WireEntry[],
  maxBytes: number,
  build: (entries: WireEntry[]) => RunHistoryPayload,
  frame: (payload: RunHistoryPayload) => string,
): RunHistoryPayload {
  const bytesOf = (e: WireEntry): number => Buffer.byteLength(JSON.stringify(e), "utf8");
  let total = 0;
  for (const e of entries) total += bytesOf(e) + 1;
  let cut = 0;
  while (entries.length - cut > 1 && total > maxBytes) {
    total -= bytesOf(entries[cut]!) + 1;
    cut++;
  }
  let capped = entries.slice(cut);
  let payload = build(capped);
  while (capped.length > 1 && Buffer.byteLength(frame(payload), "utf8") > maxBytes) {
    capped = capped.slice(1);
    payload = build(capped);
  }
  return payload;
}

export function createRunTranscriptService(deps: {
  registry: RunTxRegistryPort;
  reader: RunFileReader;
  log: HubLog;
  now?: () => number;
}): RunTranscriptService {
  const { registry, reader, log } = deps;
  const now = deps.now ?? Date.now;
  const watches = new Map<string, RunWatchState>();
  /** §5.2 RunEndLedger (#2): key `agentKey|runId`, LRU-capped, TTL-checked lazily on read. */
  const ledger = new Map<string, LedgerEntry>();
  const lastSessionIds = new Map<string, string>();
  let sink: RunSink | undefined;
  let disposed = false;

  // ------------------------------------------------------------- caps / ledger

  function requireCap(agentKey: string, listener: ListenerKind): void {
    const caps = registry.getCaps(agentKey);
    if (caps === undefined) throw new HubError("E_NOT_FOUND");
    if (!caps.includes("runtx.v1")) throw new HubError("E_UNSUPPORTED", "unsupported");
    if (listener === "lan" && !caps.includes("runtx.lan.v1")) throw new HubError("E_UNSUPPORTED", "unsupported");
  }

  function ledgerGet(agentKey: string, runId: string): LedgerEntry | undefined {
    const key = runKey(agentKey, runId);
    const v = ledger.get(key);
    if (v === undefined) return undefined;
    if (now() - v.at > RUN_TX.endLedgerTtlMs) {
      ledger.delete(key);
      return undefined;
    }
    ledger.delete(key);
    ledger.set(key, v); // LRU touch
    return v;
  }

  function ledgerSet(agentKey: string, runId: string, entry: Omit<LedgerEntry, "at">): void {
    const key = runKey(agentKey, runId);
    ledger.delete(key);
    ledger.set(key, { ...entry, at: now() });
    while (ledger.size > RUN_TX.endLedgerMax) {
      const oldest = ledger.keys().next().value;
      if (oldest === undefined) break;
      ledger.delete(oldest);
    }
  }

  // ------------------------------------------------------------- sink guards

  function safeSink(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.error("run-transcript sink threw", { error: String(err) });
    }
  }

  function sinkEv(w: RunWatchState, f: RunEvFrame): void {
    if (sink === undefined) return;
    const s = sink;
    safeSink(() =>
      s.ev(w.agentKey, w.runId, { agentKey: w.agentKey, runId: w.runId, tapId: f.tapId, seq: f.seq, e: f.e }),
    );
  }

  // ------------------------------------------------------------- watch frames

  function sendWatchFrame(agentKey: string, runId: string, on: boolean): boolean {
    return registry.send(agentKey, { t: "run_watch", runId, on });
  }

  // ------------------------------------------------------------- snapshot core

  async function requestReply(
    agentKey: string,
    runId: string,
    q: { before?: string; limit: number },
  ): Promise<RunTxReplyFrame> {
    return registry.request<RunTxReplyFrame>(
      agentKey,
      {
        t: "run_tx_req",
        rid: "",
        runId,
        ...(q.before === undefined ? {} : { before: q.before }),
        limit: q.limit,
        maxBytes: RUN_TX.maxBytes,
      },
      RUN_TX.reqDeadlineMs,
    );
  }

  function livePayload(
    agentKey: string,
    runId: string,
    entries: WireEntry[],
    reply: Extract<RunTxReplyFrame, { ok: true; source: "live" }>,
    opts: { forceNotLive: boolean; original: readonly WireEntry[] },
  ): RunHistoryPayload {
    const p: RunHistoryPayload = {
      agentKey,
      runId,
      entries,
      tailMessages: [],
      fromSeq: reply.seq + 1,
      hasMore: reply.hasMore || entries.length < opts.original.length,
      source: "live",
      terminal: false,
      status: reply.status,
      live: opts.forceNotLive ? false : reply.watching,
    };
    if (reply.inflight !== undefined) p.inflight = reply.inflight;
    if (reply.tapId !== undefined) p.tapId = reply.tapId;
    const oldest = entries[0]?.id;
    if (oldest !== undefined) p.oldestEntryId = oldest;
    return p;
  }

  function filePayload(
    agentKey: string,
    runId: string,
    entries: WireEntry[],
    hasMore: boolean,
    status: string,
    opts: { original: readonly WireEntry[] },
  ): RunHistoryPayload {
    const p: RunHistoryPayload = {
      agentKey,
      runId,
      entries,
      tailMessages: [],
      // §3.1: 0 is the epoch sentinel — a file-backed run has no live stream to resume.
      fromSeq: 0,
      hasMore: hasMore || entries.length < opts.original.length,
      source: "file",
      terminal: true,
      status,
      live: false,
    };
    const oldest = entries[0]?.id;
    if (oldest !== undefined) p.oldestEntryId = oldest;
    return p;
  }

  /**
   * Shared snapshot/page core (§5.2 reply branches). `frameUnit` picks the real wire unit for
   * `capRunPayload` (SSE frame for snapshots/resync, bare JSON for pages — §3.4);
   * `forceNotLive` implements the GET page's "`live` 恒为 false".
   */
  async function buildPayload(
    agentKey: string,
    runId: string,
    opts: { before?: string; limit: number; frameUnit: "sse" | "json"; forceNotLive: boolean },
  ): Promise<RunHistoryPayload> {
    const reply = await requestReply(agentKey, runId, {
      ...(opts.before === undefined ? {} : { before: opts.before }),
      limit: opts.limit,
    });
    if (!reply.ok) throw new HubError(reply.code, reply.reason);
    const frameOf =
      opts.frameUnit === "sse"
        ? (p: RunHistoryPayload) => formatSseFrame(RUN_HISTORY_EVENT, p)
        : (p: RunHistoryPayload) => JSON.stringify(p);
    if (reply.source === "file") {
      const r = await reader.read(reply.sessionFile, reply.finalLeafId, {
        ...(opts.before === undefined ? {} : { before: opts.before }),
        limit: opts.limit,
        maxBytes: RUN_TX.maxBytes,
        deadlineAt: now() + RUN_TX.reqDeadlineMs,
      });
      if (!r.ok) throw readerHubError(r.reason);
      return capRunPayload(
        r.entries,
        RUN_TX.maxBytes,
        (entries) => filePayload(agentKey, runId, entries, r.hasMore, reply.status, { original: r.entries }),
        frameOf,
      );
    }
    return capRunPayload(
      reply.entries,
      RUN_TX.maxBytes,
      (entries) =>
        livePayload(agentKey, runId, entries, reply, { forceNotLive: opts.forceNotLive, original: reply.entries }),
      frameOf,
    );
  }

  /**
   * P1-1 (验收修补): a terminal snapshot landing on a watch that never saw its `run_end` —
   * typically a resubscribe that hit the RunEndLedger (§5.2 use #2). The ledger may already
   * hold the REAL `{tapId,lastSeq}`: `onRunEnd` writes the ledger BEFORE the watch lookup, so
   * an end that arrived while no watch was held is recorded there. Project THAT onto the
   * watch and leave the ledger untouched; only when no ledger entry exists synthesize
   * `{tapId:"", lastSeq:w.lastSeq}`. Overwriting the ledger with synthesized watch state
   * (which on a fresh watch is `{"",0}`) would make the agent's later retry of the SAME end
   * fail dedupe and look like a new end — firing a spurious resync round.
   */
  function recordTerminalOnWatch(w: RunWatchState, status: string): void {
    if (w.ended !== undefined) return;
    const led = ledgerGet(w.agentKey, w.runId);
    if (led !== undefined) {
      w.ended = { tapId: led.tapId, lastSeq: led.lastSeq, status: led.status };
      return;
    }
    w.ended = { tapId: w.tapId ?? "", lastSeq: w.lastSeq, status };
    ledgerSet(w.agentKey, w.runId, w.ended);
  }

  /** Apply a settled snapshot to the owning watch's seq state (§3.3 resync step 3 / subscribe). */
  function applyToWatch(agentKey: string, runId: string, p: RunHistoryPayload): void {
    const w = watches.get(runKey(agentKey, runId));
    if (w === undefined) return;
    if (p.source === "live" && p.tapId !== undefined) {
      w.tapId = p.tapId;
      // max() mirrors `settleResync`'s rule: events that already streamed in between the
      // watch and this reply must not be rolled back into a phantom hole.
      w.lastSeq = Math.max(w.lastSeq, p.fromSeq - 1);
      w.contiguous = true;
      return;
    }
    if (p.terminal) {
      // A terminal snapshot while a watch is still held (e.g. resubscribe after a lost
      // run_end): record the end so ledger dedupe/re-arm behave as if the frame had arrived.
      recordTerminalOnWatch(w, p.status);
    }
  }

  // ------------------------------------------------------------- resync rounds

  function dropWatch(w: RunWatchState, err: RunHistoryError): void {
    watches.delete(runKey(w.agentKey, w.runId));
    if (w.watchOn) sendWatchFrame(w.agentKey, w.runId, false);
    w.resync.inFlight = false; // an in-flight round discards itself via the identity check
    if (sink !== undefined) {
      const s = sink;
      safeSink(() => s.dropped(w.agentKey, w.runId, err));
    }
  }

  function startResync(w: RunWatchState, reason: string): void {
    if (disposed || watches.get(runKey(w.agentKey, w.runId)) !== w) return;
    if (w.resync.inFlight) return;
    const t = now();
    w.resync.times = w.resync.times.filter((x) => t - x < RESYNC_WINDOW_MS);
    if (w.resync.times.length >= RUN_TX.resyncMaxPer10s) {
      // §3.3 storm breaker: 10s window exceeded ⇒ E_BUSY/resync_storm, watch deleted, tap off.
      log.warn("run-transcript resync storm", { agentKey: w.agentKey, runId: w.runId, reason });
      dropWatch(w, { agentKey: w.agentKey, runId: w.runId, error: "E_BUSY", reason: "resync_storm" });
      return;
    }
    w.resync.times.push(t);
    w.resync.inFlight = true;
    w.resync.again = false;
    w.resync.againEpoch = false;
    w.resync.maxGapFromSeq = undefined;
    if (sink !== undefined) {
      const s = sink;
      safeSink(() => s.resyncStart(w.agentKey, w.runId));
    }
    void settleResync(w, reason);
  }

  async function settleResync(w: RunWatchState, reason: string): Promise<void> {
    let payload: RunHistoryPayload | undefined;
    let err: HubError | undefined;
    try {
      payload = await buildPayload(w.agentKey, w.runId, {
        limit: RUN_TX.tailDefault,
        frameUnit: "sse",
        forceNotLive: false,
      });
    } catch (e) {
      err = asHubError(e);
    }
    if (disposed || watches.get(runKey(w.agentKey, w.runId)) !== w) return; // dropped/unwatched mid-round
    w.resync.inFlight = false;
    if (payload !== undefined) {
      if (payload.source === "live" && payload.tapId !== undefined) {
        w.tapId = payload.tapId;
        // §3.3 step 3 says "设 lastSeq=watermark" — but events generated AFTER the agent took
        // the snapshot can arrive BEFORE the reply lands, and the in-flight window forwarded
        // them (tracked in `lastSeq`). Rolling back to the watermark would make the very next
        // post-round event look like a hole and fire a spurious extra round, so the round
        // takes the MAX: the watermark for anything the window missed, the tracked seq for
        // anything it already delivered (subscribers dedupe overlaps against the watermark).
        w.lastSeq = Math.max(w.lastSeq, payload.fromSeq - 1);
        w.contiguous = true;
      } else if (payload.terminal) {
        recordTerminalOnWatch(w, payload.status);
      }
    }
    const s = sink;
    if (s !== undefined) {
      if (payload !== undefined) {
        payload.resync = true;
        safeSink(() => s.history(w.agentKey, w.runId, payload!));
      } else {
        log.info("run-transcript resync failed", {
          agentKey: w.agentKey,
          runId: w.runId,
          reason,
          code: err?.code,
        });
        safeSink(() => s.history(w.agentKey, w.runId, runErrorPayload(w.agentKey, w.runId, err!)));
      }
    }
    // §3.3 resync step 4 (`again`): a gap observed mid-round pointing past this round's
    // watermark, a run_end that arrived mid-round (the next snapshot takes the file path), or
    // an epoch/session re-arm — one more bounded round, itself storm-guarded. A TERMINAL
    // settle is authoritative for the STREAM's own loss signals only: it clears the
    // end-cause `again` (the terminal snapshot IS that end's answer; a further round could
    // only re-deliver the same file snapshot) — but NOT `againEpoch`: that round exists to
    // re-validate under a NEW epoch/session the stale round never saw, and for a terminal
    // run it is just a bounded, authoritative file re-read (S8: the result is a fresh
    // snapshot or a determined error such as unknown_run, never the stale terminal one).
    if (payload !== undefined && payload.terminal) w.resync.again = false;
    const again =
      w.resync.again ||
      w.resync.againEpoch ||
      (w.ended !== undefined && payload !== undefined && !payload.terminal) ||
      (payload !== undefined &&
        payload.source === "live" &&
        w.resync.maxGapFromSeq !== undefined &&
        w.resync.maxGapFromSeq > payload.fromSeq - 1);
    if (again) startResync(w, "again");
  }

  // ------------------------------------------------------------- §3.3 input table

  function onRunEv(agentKey: string, f: RunEvFrame): void {
    const w = watches.get(runKey(agentKey, f.runId));
    if (w === undefined) return; // no subscribers (or already dropped): nothing to fan out
    if (w.resync.inFlight) {
      // §3.3: pass through unchecked (subscribers buffer); the round's reply resets continuity.
      if (f.seq > w.lastSeq) w.lastSeq = f.seq;
      sinkEv(w, f);
      return;
    }
    if (w.tapId !== undefined && f.tapId !== w.tapId) {
      startResync(w, "tap-change");
      return;
    }
    if (f.seq <= w.lastSeq) return; // duplicate
    if (f.seq > w.lastSeq + 1) {
      w.contiguous = false;
      startResync(w, "hole");
      return;
    }
    w.lastSeq = f.seq;
    w.contiguous = true;
    sinkEv(w, f);
  }

  function onRunGap(agentKey: string, f: RunGapFrame): void {
    const w = watches.get(runKey(agentKey, f.runId));
    if (w === undefined) return;
    if (w.resync.inFlight) {
      // §3.3: coalesce — evaluated against the round's watermark when it settles; a gap the
      // snapshot already covers (fromSeq <= watermark) never amplifies into another round.
      w.resync.maxGapFromSeq = Math.max(w.resync.maxGapFromSeq ?? 0, f.fromSeq);
      return;
    }
    startResync(w, "gap");
  }

  function onRunEnd(agentKey: string, f: RunEndFrame): void {
    const led = ledgerGet(agentKey, f.runId);
    if (led !== undefined && led.tapId === f.tapId && led.lastSeq === f.lastSeq) return; // agent retry: drop
    ledgerSet(agentKey, f.runId, { tapId: f.tapId, lastSeq: f.lastSeq, status: f.status });
    const w = watches.get(runKey(agentKey, f.runId));
    if (w === undefined) return;
    w.ended = { tapId: f.tapId, lastSeq: f.lastSeq, status: f.status };
    if (w.resync.inFlight) {
      // Settled by the in-flight round: if its snapshot raced the terminal transition (came
      // back live), the `ended`-but-not-terminal check re-arms exactly one more round.
      w.resync.again = true;
      return;
    }
    if (w.contiguous && w.tapId === f.tapId && w.lastSeq === f.lastSeq) {
      if (sink !== undefined) {
        const s = sink;
        safeSink(() =>
          s.end(agentKey, f.runId, { agentKey, runId: f.runId, tapId: f.tapId, lastSeq: f.lastSeq, status: f.status }),
        );
      }
      return;
    }
    // §3.3/S4: never forward a broken-chain end — resync; the terminal snapshot walks the file.
    startResync(w, "end");
  }

  // ------------------------------------------------------------- bus reactions

  function onAgentDown(agentKey: string): void {
    lastSessionIds.delete(agentKey);
    for (const w of [...watches.values()]) {
      if (w.agentKey !== agentKey) continue;
      dropWatch(w, { agentKey, runId: w.runId, error: "E_AGENT_GONE" });
    }
  }

  /** §5.2: epoch change (`gap{fromSeq:0}`) or sessionId change ⇒ re-arm taps, then resync all. */
  function resyncAll(agentKey: string): void {
    for (const w of watches.values()) {
      if (w.agentKey !== agentKey) continue;
      if (ledgerGet(agentKey, w.runId) === undefined) {
        // Taps died with the agent's /reload (or were never armed): re-arm before resyncing so
        // the same socket sees `run_watch` ahead of the round's `run_tx_req` (§5.2 ordering).
        if (sendWatchFrame(agentKey, w.runId, true)) w.watchOn = true;
      }
      if (w.resync.inFlight) {
        // P1-2/S8 (验收修补): a round is already running and its snapshot PREDATES the
        // epoch/session change, so it cannot serve as the post-change authority — swallowing
        // the event here would leave the stale round as the final word. Arm `againEpoch`
        // instead: the settle path opens a fresh round through `startResync`, so the 10s/3-round
        // storm budget still applies. Unlike the end-cause `again`, this arm SURVIVES a
        // terminal settle (round 2 of the acceptance fix): a stale terminal snapshot is no
        // more authoritative than a stale live one when the epoch changed under it.
        w.resync.againEpoch = true;
        continue;
      }
      startResync(w, "epoch");
    }
  }

  /** §5.2/§7.1: caps changed (re-hello) ⇒ re-validate every held ref against the new caps. */
  function onCapsChange(agentKey: string): void {
    const caps = registry.getCaps(agentKey) ?? [];
    for (const w of [...watches.values()]) {
      if (w.agentKey !== agentKey) continue;
      const bad: string[] = [];
      for (const ref of w.refs) {
        let listener: ListenerKind;
        try {
          listener = listenerOfRef(ref);
        } catch {
          bad.push(ref);
          continue;
        }
        if (!caps.includes("runtx.v1") || (listener === "lan" && !caps.includes("runtx.lan.v1"))) bad.push(ref);
      }
      if (bad.length === 0) continue;
      for (const ref of bad) w.refs.delete(ref);
      if (sink !== undefined) {
        const s = sink;
        const err: RunHistoryError = { agentKey, runId: w.runId, error: "E_UNSUPPORTED", reason: "unsupported" };
        safeSink(() => s.dropped(agentKey, w.runId, err, bad));
      }
      if (w.refs.size === 0) {
        watches.delete(runKey(agentKey, w.runId));
        if (w.watchOn) sendWatchFrame(agentKey, w.runId, false);
        w.resync.inFlight = false;
      }
    }
  }

  const unsubscribeBus = registry.bus.subscribe((e) => {
    if (disposed) return;
    switch (e.type) {
      case "run_ev":
        onRunEv(e.agentKey, { t: "run_ev", runId: e.runId, tapId: e.tapId, seq: e.seq, e: e.e });
        return;
      case "run_gap":
        onRunGap(e.agentKey, { t: "run_gap", runId: e.runId, tapId: e.tapId, fromSeq: e.fromSeq });
        return;
      case "run_end":
        onRunEnd(e.agentKey, {
          t: "run_end",
          runId: e.runId,
          tapId: e.tapId,
          lastSeq: e.lastSeq,
          status: e.status,
        });
        return;
      case "agent_down":
        onAgentDown(e.agentKey);
        return;
      case "gap":
        // fromSeq:0 is the registry-epoch sentinel (§3.3); a main-session seq gap is the run
        // channel's nonevent (run taps report their own loss via run_gap).
        if (e.fromSeq === 0) resyncAll(e.agentKey);
        return;
      case "session": {
        const prev = lastSessionIds.get(e.agentKey);
        lastSessionIds.set(e.agentKey, e.session.sessionId);
        if (prev !== undefined && prev !== e.session.sessionId) resyncAll(e.agentKey);
        return;
      }
      case "caps":
        onCapsChange(e.agentKey);
        return;
      default:
        return;
    }
  });

  // ------------------------------------------------------------- public surface

  const service: RunTranscriptService = {
    snapshot(agentKey, runId, listener) {
      try {
        requireCap(agentKey, listener);
      } catch (err) {
        return Promise.reject(err);
      }
      return buildPayload(agentKey, runId, {
        limit: RUN_TX.tailDefault,
        frameUnit: "sse",
        forceNotLive: false,
      }).then((p) => {
        applyToWatch(agentKey, runId, p);
        return p;
      });
    },

    page(agentKey, runId, before, limit, listener) {
      try {
        requireCap(agentKey, listener);
      } catch (err) {
        return Promise.reject(err);
      }
      const lim = Math.min(RUN_TX.pageMax, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : RUN_TX.pageMax)));
      return buildPayload(agentKey, runId, {
        before,
        limit: lim,
        frameUnit: "json",
        forceNotLive: true, // §3.4: GET /api/run/history ⇒ `live` is always false
      });
    },

    watch(agentKey, runId, ref) {
      const listener = listenerOfRef(ref); // throws E_BAD_REQUEST on a malformed ref
      requireCap(agentKey, listener);
      const key = runKey(agentKey, runId);
      let w = watches.get(key);
      if (w === undefined) {
        w = {
          agentKey,
          runId,
          refs: new Set(),
          watchOn: false,
          tapId: undefined,
          lastSeq: 0,
          contiguous: true,
          ended: undefined,
          resync: { inFlight: false, again: false, againEpoch: false, times: [], maxGapFromSeq: undefined },
        };
        watches.set(key, w);
        if (ledgerGet(agentKey, runId) === undefined) {
          // §5.2 RunEndLedger use #2: a run already known terminal needs no tap — the snapshot
          // walks the file path and the agent ignores watch frames for terminal runs anyway.
          if (sendWatchFrame(agentKey, runId, true)) w.watchOn = true;
        }
      }
      w.refs.add(ref); // duplicate refs never double-count (Set semantics)
    },

    unwatch(agentKey, runId, ref) {
      const key = runKey(agentKey, runId);
      const w = watches.get(key);
      if (w === undefined) return;
      w.refs.delete(ref);
      if (w.refs.size > 0) return;
      watches.delete(key);
      if (w.watchOn) sendWatchFrame(agentKey, runId, false);
      w.resync.inFlight = false; // an in-flight round discards itself via the identity check
    },

    onFrame(agentKey, f) {
      if (disposed) return;
      switch (f.t) {
        case "run_ev":
          onRunEv(agentKey, f);
          return;
        case "run_gap":
          onRunGap(agentKey, f);
          return;
        case "run_end":
          onRunEnd(agentKey, f);
          return;
      }
    },

    setSink(s) {
      sink = s;
    },

    dispose() {
      disposed = true;
      watches.clear();
      ledger.clear();
      lastSessionIds.clear();
      unsubscribeBus();
    },
  };
  return service;
}
