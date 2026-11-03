/**
 * fabric-thread P1 (arch r3 §3.1): the agent-side ThreadDirectory — an LRU of the threads the
 * hub has shown us, capacity 32, held in stack memory (I4: per-engine instance, never module
 * scope). Admission (§5.1) requires the handle to be here AND open.
 *
 * Recency source: `note()` — the hub re-attaches thread meta to every thread-bearing frame, so a
 * live thread keeps touching itself; `get`/`isOpen` are read-only and do NOT refresh recency
 * (deliberate: admission probes must not keep a dead thread hot).
 *
 * rebind-plan r3 §2.3/§4.7 (the header this replaces was WRONG): the handle is derived from the
 * bindingKey (`grp:<chatId>:<threadId>`), which does NOT contain the sessionId — so a REBIND
 * keeps the SAME `h`; only switching to a different topic mints a new one. `close()` (§5.4
 * thr_closed, including `reason:"rebound"`) stays ONE-WAY: `note` on a closed entry updates the
 * label but never resurrects it. The ONLY way back to `open` is `reopen()`, driven exclusively
 * by a trusted `thr_req{op:"acquire"}` hub answer (`{owned:true}`) — a stale local flag or an
 * xs text mentioning `h` can never reopen an entry (D5).
 *
 * `rev` (§4.7): the last TRUSTED binding rev we observed (cmd.thread meta / acquire / rebind
 * receipts). Saved as a MONOTONIC MAX on `note`/`reopen`/`noteRev` (out-of-order frames must not
 * roll it back); `close()` CLEARS it — a closed entry's rev is no longer fresh, so a later
 * reopen always carries the hub's CURRENT rev from the acquire receipt.
 */
import type { ThreadHandle } from "./types.js";

export const THREAD_DIRECTORY_CAPACITY = 32;

export interface ThreadDirectoryEntry {
  readonly h: ThreadHandle;
  label: string;
  closed: boolean;
  lastTouchedAt: number;
  /** rebind-plan r3 §4.7: the last trusted binding rev (monotonic max; cleared by `close()`). */
  rev?: number;
}

export class ThreadDirectory {
  /** Map iteration order = LRU order (oldest first); re-insert on touch. */
  private readonly entries = new Map<ThreadHandle, ThreadDirectoryEntry>();

  constructor(private readonly capacity: number = THREAD_DIRECTORY_CAPACITY) {}

  get size(): number {
    return this.entries.size;
  }

  /** §4.7 monotonic-max merge — `rev` only ever climbs on an entry. */
  private static mergeRev(entry: ThreadDirectoryEntry, rev: number | undefined): void {
    if (rev === undefined) return;
    entry.rev = entry.rev === undefined ? rev : Math.max(entry.rev, rev);
  }

  /** Observe/refresh a thread from a valid thread-bearing frame (hub-driven). `rev` is the
   *  optional trusted binding rev riding `cmd.thread` (§4.7 — only attached when BOTH ends
   *  carry `thr.rebind.v1`). */
  note(h: ThreadHandle, label: string, now: number, rev?: number): void {
    const existing = this.entries.get(h);
    if (existing) {
      existing.label = label;
      existing.lastTouchedAt = now;
      ThreadDirectory.mergeRev(existing, rev);
      this.entries.delete(h);
      this.entries.set(h, existing); // refresh recency; keep closed as-is (never resurrect)
      return;
    }
    while (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value as ThreadHandle | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(h, { h, label, closed: false, lastTouchedAt: now, ...(rev === undefined ? {} : { rev }) });
  }

  /** rebind-plan r3 §4.7: the ONLY reopen path, driven by a trusted acquire receipt. Resurrects
   *  a closed entry (or refreshes an open one) and records the hub's CURRENT rev. */
  reopen(h: ThreadHandle, label: string, now: number, rev?: number): void {
    const existing = this.entries.get(h);
    if (existing) {
      existing.label = label;
      existing.closed = false;
      existing.lastTouchedAt = now;
      ThreadDirectory.mergeRev(existing, rev);
      this.entries.delete(h);
      this.entries.set(h, existing);
      return;
    }
    this.note(h, label, now, rev);
  }

  /** §4.7 rebind receipt freshness — monotonic max, never creates an entry. */
  noteRev(h: ThreadHandle, rev: number): void {
    const existing = this.entries.get(h);
    if (existing !== undefined) ThreadDirectory.mergeRev(existing, rev);
  }

  /** Read-only lookup (does NOT touch recency — see the header). */
  get(h: ThreadHandle): ThreadDirectoryEntry | undefined {
    return this.entries.get(h);
  }

  /** §5.1 admission predicate: known ∧ not closed. */
  isOpen(h: ThreadHandle): boolean {
    const e = this.entries.get(h);
    return e !== undefined && !e.closed;
  }

  /** §5.4 thr_closed{h}: returns whether an OPEN entry existed (and is now closed). §4.7: the
   *  rev is dropped with the close — it is no longer fresh once the binding moved. */
  close(h: ThreadHandle): boolean {
    const e = this.entries.get(h);
    if (e === undefined || e.closed) return false;
    e.closed = true;
    delete e.rev;
    return true;
  }

  /** Ordered snapshot (oldest first) — for tests/status. */
  list(): ThreadDirectoryEntry[] {
    return [...this.entries.values()];
  }
}
