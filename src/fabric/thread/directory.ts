/**
 * fabric-thread P1 (arch r3 §3.1): the agent-side ThreadDirectory — an LRU of the threads the
 * hub has shown us, capacity 32, held in stack memory (I4: per-engine instance, never module
 * scope). Admission (§5.1) requires the handle to be here AND open.
 *
 * Recency source: `note()` — the hub re-attaches thread meta to every thread-bearing frame, so a
 * live thread keeps touching itself; `get`/`isOpen` are read-only and do NOT refresh recency
 * (deliberate: admission probes must not keep a dead thread hot). `close()` (§5.4 thr_closed)
 * marks the entry closed forever — a re-bound binding mints a NEW handle (bindingKey changed ⇒
 * HMAC changed), so `note` on a closed entry updates the label but never resurrects it.
 */
import type { ThreadHandle } from "./types.js";

export const THREAD_DIRECTORY_CAPACITY = 32;

export interface ThreadDirectoryEntry {
  readonly h: ThreadHandle;
  label: string;
  closed: boolean;
  lastTouchedAt: number;
}

export class ThreadDirectory {
  /** Map iteration order = LRU order (oldest first); re-insert on touch. */
  private readonly entries = new Map<ThreadHandle, ThreadDirectoryEntry>();

  constructor(private readonly capacity: number = THREAD_DIRECTORY_CAPACITY) {}

  get size(): number {
    return this.entries.size;
  }

  /** Observe/refresh a thread from a valid thread-bearing frame (hub-driven). */
  note(h: ThreadHandle, label: string, now: number): void {
    const existing = this.entries.get(h);
    if (existing) {
      existing.label = label;
      existing.lastTouchedAt = now;
      this.entries.delete(h);
      this.entries.set(h, existing); // refresh recency; keep closed as-is (never resurrect)
      return;
    }
    while (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value as ThreadHandle | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(h, { h, label, closed: false, lastTouchedAt: now });
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

  /** §5.4 thr_closed{h}: returns whether an OPEN entry existed (and is now closed). */
  close(h: ThreadHandle): boolean {
    const e = this.entries.get(h);
    if (e === undefined || e.closed) return false;
    e.closed = true;
    return true;
  }

  /** Ordered snapshot (oldest first) — for tests/status. */
  list(): ThreadDirectoryEntry[] {
    return [...this.entries.values()];
  }
}
