/**
 * Agent-side run-transcript service (web-hub-fleet-drawer plan §4.2, package F2).
 *
 * One live tap per watched run (`createEventTap` reused for its 50ms delta coalescing,
 * 250ms tool-update throttle, 64 KiB truncation and inflight tracking), plus snapshot/page
 * answers for `run_tx_req` and the §3.3 seq/gap/end protocol:
 *  - every event allocates its seq BEFORE `trySend` (wire seqs start at 1); a non-written
 *    frame folds into `firstMissing` (min-merge), retried as a non-droppable
 *    `run_gap{fromSeq}` on every tick / link-up / before the next send — sends never pause;
 *  - run end: `tap.flush()` → gap → `run_end{lastSeq}` (never overtakes an unsent gap); an
 *    undelivered end goes to `endedPending` (cap `RUN_TX.endPendingMax`, TTL
 *    `RUN_TX.endPendingTtlMs`, retried on tick/link-up in gap-then-end order);
 *  - snapshot: synchronous `tap.flush()`, read `seq` as the watermark, then walk the branch
 *    tail → `projectSessionEntry` until `limit`/`maxBytes` (byte accounting identical to
 *    `snapshot.ts`'s `buildBranchReply`), reply `seq=watermark` + `tapId`;
 *  - terminal runs unconditionally take the deterministic file path (`sessionFile` +
 *    `finalLeafId`, else `not_persisted` / `leaf_unknown`), regardless of any live handle.
 *
 * Compat posture (§3.2 matrix, F0 review ruling): when `enabled()` is false (the live
 * link's `hello_ack.caps` lacks `runtx.v1`, or `webHub.subagentTranscript` is `"off"`),
 * `run_tx_req`/`run_watch` are silently ignored — no reply, no tap — and a link-up without
 * the cap tears every tap down rather than leaking frames to a hub that cannot decode them.
 *
 * Session lifetime (§4.4, F2 verifier P1): `resetForSession()` — called from
 * `session_shutdown` — detaches every tap/observer and drops `endedPending`, but the
 * service stays USABLE: `/new`・`/resume`・`/fork` are a shutdown→start pair inside the
 * same activation, and the next session's `run_watch`/`run_tx_req` must work again (same
 * lifecycle precedent as the main-session `EventTap`'s dispose/resetForSession pair in
 * `agent/index.ts`). There is deliberately no permanent `dispose()`: pi extensions get no
 * deactivate hook, and `/reload` tears the whole module instance down (the shutdown
 * handler still runs first, so observers never leak into the rebuilt stack).
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { projectSessionEntry } from "../protocol/keys.js";
import type { AgentFrame, WireEntry, WireEvent } from "../protocol/messages.js";
import { RUN_TX, type RunTxReplyFrame, type RunTxReqFrame } from "../protocol/run-transcript.js";
import type { SendResult } from "./connection.js";
import { createEventTap, type EventTap } from "./event-tap.js";

/** Terminal snapshot fields the file path needs (§4.2): hub reads the session file itself. */
export interface RunTxRunInfo {
  status: string;
  terminal: boolean;
  sessionFile?: string;
  finalLeafId?: string;
}

/**
 * Read port over the service layer (F1's `QueryService.branchOf`/`observe`, wrapped by
 * `agent/index.ts`). Signatures stay `unknown`-based (I1); everything degrades to a
 * deterministic answer instead of throwing.
 */
export interface RunTranscriptPort {
  info(runId: string): RunTxRunInfo | undefined;
  branch(runId: string): readonly unknown[] | undefined;
  observe(
    runId: string,
    l: { onEvent(e: unknown): void; onEnd(status: string): void },
  ):
    | { kind: "attached"; detach(): void }
    | { kind: "terminal"; status: string }
    | { kind: "no_session" }
    | { kind: "unknown" };
}

interface TapRecord {
  readonly runId: string;
  readonly tapId: string;
  /** §3.3 #1: 0 until the first event; the wire's first legal seq is 1. */
  seq: number;
  /** First lost seq (min-merged across losses); cleared only after its `run_gap` is written. */
  firstMissing?: number;
  readonly detach: () => void;
  readonly tap: EventTap;
  ended?: { status: string };
}

/** An undelivered `run_end` (plus the gap that must still precede it), §3.3 #4 / §3.5. */
interface EndedPending {
  readonly runId: string;
  readonly tapId: string;
  readonly lastSeq: number;
  firstMissing?: number;
  readonly status: string;
  readonly since: number;
}

export function createRunTranscripts(deps: {
  port: () => RunTranscriptPort | undefined;
  trySend: (f: AgentFrame, o?: { droppable?: boolean }) => SendResult;
  /** `hello_ack.caps` contains `runtx.v1` and the `webHub.subagentTranscript` setting ≠ "off". */
  enabled: () => boolean;
  now: () => number;
  setTimer: (ms: number, fn: () => void) => { cancel(): void };
}): {
  onReq(f: RunTxReqFrame): void;
  onWatch(runId: string, on: boolean): void;
  onLink(live: boolean): void;
  tick(): void;
  /** Session-boundary cleanup (NOT a kill switch — see the file header): detach every tap
   *  and drop every pending end; the service answers the next session's calls normally. */
  resetForSession(): void;
} {
  const taps = new Map<string, TapRecord>();
  let endedPending: EndedPending[] = [];

  const isLive = (rec: TapRecord): boolean => taps.get(rec.runId) === rec;

  /** §3.3 #3: a written gap clears `firstMissing`; any other outcome keeps it (min-merged). */
  const tryGap = (rec: TapRecord): void => {
    if (rec.firstMissing === undefined) return;
    const r = deps.trySend({ t: "run_gap", runId: rec.runId, tapId: rec.tapId, fromSeq: rec.firstMissing });
    if (r === "written") delete rec.firstMissing;
  };

  /** Tap sink: gap first (never pausing the event), then seq++ occupies the number, then send. */
  const sendEv = (rec: TapRecord, e: WireEvent, droppable: boolean): void => {
    if (!isLive(rec)) return; // a disposed/removed tap never emits another frame
    if (rec.firstMissing !== undefined) tryGap(rec);
    rec.seq += 1;
    const r = deps.trySend({ t: "run_ev", runId: rec.runId, tapId: rec.tapId, seq: rec.seq, e }, { droppable });
    if (r !== "written") {
      rec.firstMissing = rec.firstMissing === undefined ? rec.seq : Math.min(rec.firstMissing, rec.seq);
    }
  };

  const removeTap = (rec: TapRecord): void => {
    if (taps.get(rec.runId) !== rec) return;
    taps.delete(rec.runId);
    try {
      rec.detach();
    } catch {
      /* detach must never throw into a pi event path */
    }
    rec.tap.dispose();
  };

  /** §3.3 #4 / §3.5: park an undeliverable end; retried gap-first on tick / link-up. */
  const parkEnded = (rec: TapRecord, status: string): void => {
    const entry: EndedPending = { runId: rec.runId, tapId: rec.tapId, lastSeq: rec.seq, status, since: deps.now() };
    if (rec.firstMissing !== undefined) entry.firstMissing = rec.firstMissing;
    endedPending.push(entry);
    while (endedPending.length > RUN_TX.endPendingMax) endedPending.shift(); // FIFO bound
    removeTap(rec);
  };

  const endTap = (rec: TapRecord, status: string): void => {
    if (!isLive(rec) || rec.ended !== undefined) return;
    rec.ended = { status };
    rec.tap.flush(); // pending deltas get their seqs BEFORE lastSeq is read (§3.3 #4/#5)
    tryGap(rec);
    if (rec.firstMissing === undefined) {
      const r = deps.trySend({ t: "run_end", runId: rec.runId, tapId: rec.tapId, lastSeq: rec.seq, status });
      if (r === "written") {
        removeTap(rec);
        return;
      }
    }
    parkEnded(rec, status);
  };

  /** endedPending retry pass: TTL-evict first, then gap → end per entry (never end over a gap). */
  const retryEndedPending = (): void => {
    if (endedPending.length === 0) return;
    const now = deps.now();
    const keep: EndedPending[] = [];
    for (const p of endedPending) {
      if (now - p.since > RUN_TX.endPendingTtlMs) continue;
      if (p.firstMissing !== undefined) {
        const g = deps.trySend({ t: "run_gap", runId: p.runId, tapId: p.tapId, fromSeq: p.firstMissing });
        if (g === "written") delete p.firstMissing;
      }
      if (p.firstMissing !== undefined) {
        keep.push(p);
        continue;
      }
      const r = deps.trySend({ t: "run_end", runId: p.runId, tapId: p.tapId, lastSeq: p.lastSeq, status: p.status });
      if (r !== "written") keep.push(p);
    }
    endedPending = keep;
  };

  const retryGaps = (): void => {
    for (const rec of taps.values()) {
      if (rec.firstMissing !== undefined) tryGap(rec);
    }
  };

  const reply = (frame: RunTxReplyFrame): void => {
    deps.trySend(frame); // non-droppable; a lost reply is covered by the hub's own deadline/retry
  };

  /** The port is a best-effort read seam (a stale stack must never throw into pi). */
  const safePort = (): RunTranscriptPort | undefined => {
    try {
      return deps.port();
    } catch {
      return undefined;
    }
  };

  const replyErr = (
    f: RunTxReqFrame,
    reason: "unknown_run" | "not_persisted" | "leaf_unknown" | "leaf_missing",
  ): void => {
    reply({ t: "run_tx_reply", rid: f.rid, runId: f.runId, ok: false, code: "E_NOT_FOUND", reason });
  };

  /** Terminal runs are ALWAYS answered from the persisted file path (§4.2) — deterministic. */
  const replyTerminal = (f: RunTxReqFrame, info: RunTxRunInfo): void => {
    if (info.sessionFile === undefined) {
      replyErr(f, "not_persisted");
      return;
    }
    if (info.finalLeafId === undefined) {
      replyErr(f, "leaf_unknown");
      return;
    }
    reply({
      t: "run_tx_reply",
      rid: f.rid,
      runId: f.runId,
      ok: true,
      source: "file",
      status: info.status,
      sessionFile: info.sessionFile,
      finalLeafId: info.finalLeafId,
    });
  };

  const onReq = (f: RunTxReqFrame): void => {
    if (!deps.enabled()) return; // §3.2: a hub without runtx.v1 is never answered
    try {
      const port = safePort();
      if (port === undefined) return;
      const info = port.info(f.runId);
      if (info === undefined) {
        replyErr(f, "unknown_run");
        return;
      }
      if (info.terminal) {
        replyTerminal(f, info);
        return;
      }
      const rec = taps.get(f.runId);
      rec?.tap.flush(); // §3.3 #5: flush → watermark → branch → inflight, all in this same tick
      let raw = port.branch(f.runId);
      let live = info;
      if (raw === undefined) {
        // The run may have crossed into terminal between info() and branch() (or the handle
        // never existed). Re-read once and take the deterministic terminal path when it did
        // (§4.2); a still-running handle-less run simply has nothing persisted yet.
        const again = port.info(f.runId);
        if (again === undefined) {
          replyErr(f, "unknown_run");
          return;
        }
        if (again.terminal) {
          replyTerminal(f, again);
          return;
        }
        live = again;
        raw = [];
      }
      const projected: WireEntry[] = [];
      for (const r of raw) {
        const e = projectSessionEntry(r);
        if (e !== undefined) projected.push(e);
      }
      let head = projected.length; // candidates are projected[0..head-1]; `before` shrinks it
      if (f.before !== undefined) {
        const at = projected.findIndex((e) => e.id === f.before);
        if (at === -1) {
          replyErr(f, "leaf_missing");
          return;
        }
        head = at;
      }
      const limit = Math.max(0, Math.floor(f.limit));
      const budget = Math.max(0, Math.min(f.maxBytes, RUN_TX.maxBytes));
      // Tail walk, byte accounting identical to snapshot.ts's buildBranchReply (+1 per line).
      let used = 0;
      let start = head;
      let truncated = false;
      for (let i = head - 1; i >= 0 && start > head - limit; i--) {
        const size = Buffer.byteLength(JSON.stringify(projected[i]), "utf8") + 1;
        if (used + size > budget) {
          truncated = true;
          break;
        }
        used += size;
        start = i;
      }
      const frame: RunTxReplyFrame = {
        t: "run_tx_reply",
        rid: f.rid,
        runId: f.runId,
        ok: true,
        source: "live",
        status: live.status,
        seq: rec?.seq ?? 0, // watermark; 0 (and no tapId) when no tap is attached (§3.1)
        watching: rec !== undefined,
        entries: projected.slice(start, head),
        truncated,
        hasMore: start > 0,
      };
      if (rec !== undefined) {
        frame.tapId = rec.tapId;
        const inflight = rec.tap.inflight();
        if (inflight !== undefined) frame.inflight = inflight;
      }
      reply(frame);
    } catch {
      /* a misbehaving port/tap must never throw into the socket machinery */
    }
  };

  const onWatch = (runId: string, on: boolean): void => {
    if (!deps.enabled()) return; // silent posture (§3.2 compat matrix)
    if (!on) {
      const rec = taps.get(runId);
      if (rec !== undefined) removeTap(rec);
      endedPending = endedPending.filter((p) => p.runId !== runId);
      return;
    }
    if (taps.has(runId)) return; // idempotent
    if (taps.size >= RUN_TX.tapsPerAgent) return; // snapshots will answer watching:false
    try {
      const port = safePort();
      if (port === undefined) return;
      let rec: TapRecord | undefined;
      const tap = createEventTap(
        (e, droppable) => {
          if (rec !== undefined) sendEv(rec, e, droppable);
        },
        { now: deps.now, setTimer: deps.setTimer, currentSeq: () => rec?.seq ?? 0 },
      );
      let res: ReturnType<RunTranscriptPort["observe"]>;
      try {
        res = port.observe(runId, {
          onEvent: (e) => {
            if (rec !== undefined && rec.ended === undefined && isLive(rec)) {
              rec.tap.handle(e as { type: string } & Record<string, unknown>);
            }
          },
          onEnd: (status) => {
            if (rec !== undefined) endTap(rec, status);
          },
        });
      } catch {
        tap.dispose();
        return;
      }
      if (res.kind !== "attached") {
        // terminal / no_session / unknown: no tap — snapshots answer the true state instead.
        tap.dispose();
        return;
      }
      rec = { runId, tapId: randomBytes(12).toString("base64url"), seq: 0, detach: res.detach, tap };
      taps.set(runId, rec);
    } catch {
      /* a misbehaving port must never throw into the socket machinery */
    }
  };

  const onLink = (live: boolean): void => {
    if (!live) return;
    if (!deps.enabled()) {
      // The new link's hub never advertised runtx.v1 (e.g. an older hub won the socket):
      // nothing on this channel is decodable there — tear down instead of leaking frames.
      for (const rec of [...taps.values()]) removeTap(rec);
      endedPending = [];
      return;
    }
    retryGaps(); // §3.3 #3: link-up retries gaps…
    retryEndedPending(); // …then pending ends, gap-before-end per entry
  };

  const tick = (): void => {
    retryGaps();
    retryEndedPending();
  };

  const resetForSession = (): void => {
    for (const rec of [...taps.values()]) removeTap(rec);
    endedPending = [];
  };

  return { onReq, onWatch, onLink, tick, resetForSession };
}
