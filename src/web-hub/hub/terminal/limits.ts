import type { TerminalIngressMeta } from "../ports.js";

/** Terminal-only bounded admission/scheduling. No PTY, pi or bash-job dependency. */
import { createSegmentedClock } from "../../../core/clock.js";
import { TERMINAL_LIMITS as L, type TerminalHubConfig } from "../../protocol/terminal.js";

/** Mirror of core clampSpanMs: hub must not import the deadline/domain closure. */
export function clampSpanMs(ms: number, fallback = 0, cap = Number.MAX_SAFE_INTEGER): number {
  return Number.isFinite(ms) ? Math.max(0, Math.min(cap, Math.trunc(ms))) : fallback;
}
export function terminalClock(now: () => number) {
  return createSegmentedClock({
    now,
    set: (ms, fn) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    },
    clear: (t) => clearTimeout(t as NodeJS.Timeout),
  });
}
export class TerminalFault extends Error {
  constructor(
    readonly code: import("../../protocol/terminal.js").TerminalErrorCode,
    readonly effect: "none" | "unknown" = "none",
  ) {
    super(code);
  }
}
export function failure(e: unknown) {
  return e instanceof TerminalFault
    ? { ok: false as const, code: e.code, effect: e.effect }
    : { ok: false as const, code: "E_UNAVAILABLE" as const, effect: "unknown" as const };
}
/** Cancel logical wait only; callers retain all physical reservations after unknown effects. */
export async function bounded<T>(work: Promise<T>, now: () => number, at: number, signal: AbortSignal): Promise<T> {
  void work.catch(() => {}); // Work has already started, even when preflight refuses the wait.
  if (signal.aborted || now() >= at) throw new TerminalFault("E_DEADLINE", "unknown");
  return new Promise<T>((resolve, reject) => {
    const clock = terminalClock(now);
    const end = (fn: () => void) => {
      clock.clearTimer(timer);
      signal.removeEventListener("abort", abort);
      fn();
    };
    const abort = () => end(() => reject(new TerminalFault("E_DEADLINE", "unknown")));
    const timer = clock.setTimer(clampSpanMs(at - now()), abort);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (v) =>
        end(() => {
          if (signal.aborted || now() >= at) reject(new TerminalFault("E_DEADLINE", "unknown"));
          else resolve(v);
        }),
      (e) => end(() => reject(e)),
    );
  });
}
export const TERMINAL_QUEUE_ITEMS = 128;
export class TerminalLimits {
  private slots = new Map<string, { session: string; principal: string }>();
  private queues = new Map<
    string,
    Array<{ bytes: number; frameBytes: number; coalesceKey?: string; replay: boolean; send: () => boolean }>
  >();
  private pending = new Map<string, number>();
  private credits = new Map<string, number>();
  private tickAt: number;
  private totalCredit = L.hubRateBytes as number;
  private replayCredit = L.replayRateBytes as number;
  private replay = new Set<string>();
  constructor(
    private readonly config: TerminalHubConfig,
    private readonly now: () => number,
  ) {
    this.tickAt = now();
  }
  get physicalUsed() {
    return this.slots.size;
  }
  full(session: string, principal: string, intersection: TerminalHubConfig = this.config): boolean {
    const rows = [...this.slots.values()];
    return (
      rows.length >= Math.min(L.hardTotal, this.config.maxTotal) ||
      rows.filter((x) => x.session === session).length >=
        Math.min(this.config.maxPerSession, intersection.maxPerSession) ||
      rows.filter((x) => x.principal === principal).length >=
        Math.min(this.config.maxPerPrincipal, intersection.maxPerPrincipal)
    );
  }
  reserve(id: string, session: string, principal: string, intersection: TerminalHubConfig = this.config): boolean {
    if (this.slots.has(id)) return false;
    if (this.full(session, principal, intersection)) throw new TerminalFault("E_LIMIT");
    this.slots.set(id, { session, principal });
    return true;
  }
  /** Only the durable resource-fence proof CAS may invoke this. Never a request finally. */
  releaseProven(id: string) {
    return this.slots.delete(id);
  }
  beginReplay(id: string) {
    this.refill();
    if (this.replay.has(id) || this.replay.size >= L.replayAttempts || this.replayCredit < L.replayBytes)
      throw new TerminalFault("E_REPLAY_BUSY");
    this.replay.add(id);
    this.replayCredit -= L.replayBytes;
    return L.replayBytes;
  }
  endReplay(id: string) {
    this.replay.delete(id);
  }
  enqueue(
    id: string,
    bytes: number,
    send: () => boolean,
    replay = false,
    metadata: { frameBytes: number; coalesceKey?: string } = { frameBytes: bytes + 512 },
  ): boolean {
    const q = this.queues.get(id) ?? [];
    const last = q.at(-1);
    const replace = metadata.coalesceKey !== undefined && last?.coalesceKey === metadata.coalesceKey ? last : undefined;
    const frameBytes = metadata.frameBytes;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > L.outputChunkBytes ||
      !Number.isSafeInteger(frameBytes) ||
      frameBytes < 1 ||
      (this.pending.get(id) ?? 0) + bytes - (replace?.bytes ?? 0) > L.liveStagingBytes ||
      q.length + (replace ? 0 : 1) > TERMINAL_QUEUE_ITEMS ||
      q.reduce((sum, x) => sum + x.frameBytes, 0) + frameBytes - (replace?.frameBytes ?? 0) > L.nonRingPendingBytes
    )
      return false;
    if (replace) q.pop();
    q.push({ bytes, send, replay, ...metadata });
    this.queues.set(id, q);
    this.pending.set(id, (this.pending.get(id) ?? 0) + bytes - (replace?.bytes ?? 0));
    return true;
  }
  queuedItems() {
    return [...this.queues.values()].reduce((sum, q) => sum + q.length, 0);
  }
  queuedFrameBytes() {
    return [...this.queues.values()].reduce((sum, q) => sum + q.reduce((n, x) => n + x.frameBytes, 0), 0);
  }
  drop(id: string) {
    this.queues.delete(id);
    this.pending.delete(id);
    this.credits.delete(id);
    this.endReplay(id);
  }
  private refill() {
    const delta = clampSpanMs(this.now() - this.tickAt);
    this.tickAt = this.now();
    this.totalCredit = Math.min(L.hubRateBytes, this.totalCredit + (delta * L.hubRateBytes) / 1000);
    this.replayCredit = Math.min(L.replayRateBytes, this.replayCredit + (delta * L.replayRateBytes) / 1000);
    for (const [id, c] of this.credits)
      this.credits.set(id, Math.min(L.liveRateBytes, c + (delta * L.liveRateBytes) / 1000));
  }
  /** At most one ordered frame per term per pass; raw data alone spends rate credits. */
  drain(): void {
    this.refill();
    for (const [id, q] of [...this.queues]) {
      const x = q[0];
      if (!x) continue;
      const credit = this.credits.get(id) ?? L.liveRateBytes;
      if (x.bytes > credit || x.bytes > this.totalCredit - (x.replay ? 0 : L.replayRateBytes)) continue;
      q.shift();
      this.pending.set(id, (this.pending.get(id) ?? 0) - x.bytes);
      this.credits.set(id, credit - x.bytes);
      this.totalCredit -= x.bytes;
      if (!x.send()) this.drop(id);
      else if (!q.length) {
        this.queues.delete(id);
        this.pending.delete(id);
      } else {
        this.queues.delete(id);
        this.queues.set(id, q);
      }
    }
  }
  queuedBytes() {
    return [...this.pending.values()].reduce((a, b) => a + b, 0);
  }
}

export function sameTerminalMeta(a: TerminalIngressMeta, b: TerminalIngressMeta) {
  return a.agentKey === b.agentKey && a.linkGen === b.linkGen && a.sessionId === b.sessionId && a.epoch === b.epoch;
}
