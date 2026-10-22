/**
 * Cross-session inbox unread counter (channel-plan §12, IB1). pi-free.
 *
 * UX hint only, not a correctness invariant: prefer clearing early over never
 * clearing. Every entry (overflow included) has exactly one exit condition —
 * "a model turn that STARTED after the write has completed".
 *
 * State lives on a process-level `Symbol.for` global so it survives `/reload`
 * (stack rebuilds never clear it); buckets are per sessionId (switching away
 * and back restores the count; fork / new sessions start from 0).
 */

export const XS_UNREAD_KEY = Symbol.for("pi-subagent:xs-unread");

/** Max sessions tracked at once (FIFO by least-recently touched). */
export const MAX_UNREAD_SESSIONS = 32;
/** Max distinct ids tracked per session; beyond it the oldest spill into overflow. */
export const MAX_UNREAD_IDS = 128;

/** Observation contract for the two host write exits (session-bound by the wiring). */
export interface XsUnreadTap {
  /** `id` = details.xid; omitted (NoticeGate quiet writes) ⇒ a memory-only `n:<seq>` id is synthesized. */
  written(id?: string): void;
}

export interface UnreadBucket {
  seq: number;
  turnStartSeq: number | undefined;
  ids: Map<string, number>;
  overflowPending: number;
  overflowEligible: number;
}

interface UnreadStore {
  buckets: Map<string, UnreadBucket>;
}

function store(): UnreadStore {
  const g = globalThis as unknown as Record<symbol, UnreadStore | undefined>;
  let s = g[XS_UNREAD_KEY];
  if (!s || !(s.buckets instanceof Map)) {
    s = { buckets: new Map() };
    g[XS_UNREAD_KEY] = s;
  }
  return s;
}

/** Get-or-create + mark as most recently touched; evicts the stalest session beyond the cap. */
function touch(sessionId: string): UnreadBucket {
  const { buckets } = store();
  let b = buckets.get(sessionId);
  if (b) {
    buckets.delete(sessionId); // re-insert ⇒ moves to the back
  } else {
    b = {
      seq: 0,
      turnStartSeq: undefined,
      ids: new Map(),
      overflowPending: 0,
      overflowEligible: 0,
    };
  }
  buckets.set(sessionId, b);
  while (buckets.size > MAX_UNREAD_SESSIONS) {
    const oldest = buckets.keys().next();
    if (oldest.done) break;
    buckets.delete(oldest.value);
  }
  return b;
}

function peek(sessionId: string): UnreadBucket | undefined {
  return store().buckets.get(sessionId);
}

function dropIfEmpty(sessionId: string, b: UnreadBucket): void {
  if (b.ids.size === 0 && b.overflowPending === 0 && b.overflowEligible === 0 && b.turnStartSeq === undefined) {
    store().buckets.delete(sessionId);
  }
}

/** A tap observed a successful host write. Duplicate ids are ignored. */
export function written(sessionId: string, id?: string): void {
  const b = touch(sessionId);
  const key = id !== undefined && id !== "" ? id : `n:${b.seq + 1}`;
  if (b.ids.has(key)) return;
  b.seq += 1;
  b.ids.set(key, b.seq);
  while (b.ids.size > MAX_UNREAD_IDS) {
    const oldest = b.ids.entries().next();
    if (oldest.done) break;
    const [oldId, oldSeq] = oldest.value;
    b.ids.delete(oldId);
    // Written before the active turn started ⇒ that turn's completion clears it.
    // Otherwise (no active turn, or written during it) ⇒ wait for the next turn_start.
    if (b.turnStartSeq !== undefined && oldSeq < b.turnStartSeq) b.overflowEligible += 1;
    else b.overflowPending += 1;
  }
}

/** Extension `turn_start` (every turn, including the first). */
export function turnStart(sessionId: string): void {
  const b = touch(sessionId);
  b.seq += 1;
  b.turnStartSeq = b.seq;
  b.overflowEligible += b.overflowPending;
  b.overflowPending = 0;
}

function settleTurn(sessionId: string): void {
  const b = peek(sessionId);
  if (!b) return;
  const t = b.turnStartSeq;
  if (t !== undefined) {
    for (const [id, seq] of b.ids) if (seq < t) b.ids.delete(id);
    b.overflowEligible = 0;
    b.turnStartSeq = undefined;
  }
  dropIfEmpty(sessionId, b);
}

/** Extension `turn_end` (after the assistant is persisted). Idempotent. */
export function turnEnd(sessionId: string): void {
  settleTurn(sessionId);
}

/** Extension `agent_end` fallback when turn_end never fired. Same rule, idempotent. */
export function agentEnd(sessionId: string): void {
  settleTurn(sessionId);
}

export function count(sessionId: string): number {
  const b = peek(sessionId);
  return b ? b.ids.size + b.overflowPending + b.overflowEligible : 0;
}

/** `0` stays `"0"`; callers hide the badge at 0. Above 99 ⇒ `99+`. */
export function display(n: number): string {
  return n > 99 ? "99+" : String(Math.max(0, Math.trunc(n)));
}

/** Drop a session's bucket (explicit forget; normal switching never needs it). */
export function forget(sessionId: string): void {
  store().buckets.delete(sessionId);
}

/** Session-bound tap for the host write exits. Never throws. */
export function createUnreadTap(sessionId: () => string | undefined): XsUnreadTap {
  return {
    written(id?: string): void {
      try {
        const sid = sessionId();
        if (sid) written(sid, id);
      } catch {
        /* observation only */
      }
    },
  };
}

/** Test seam: wipe the process-level state. */
export function resetUnreadForTests(): void {
  store().buckets.clear();
}
