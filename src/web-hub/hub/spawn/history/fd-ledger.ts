/**
 * web-hub session-history plan v3.3 W1 ("全局 fd 账本取代按槽位计数"): a private, in-process
 * ledger counting ACTUAL fd reservations by kind (`gen` | `pin` | `temp`), capped at
 * `HISTORY_FD_MAX`. `reserve()` is synchronous and never queues — a request that cannot reserve
 * degrades immediately (list page `partial:{busy}`, POST 503 `busy`); it is the HARD upper bound,
 * with EMFILE/ENFILE from the OS treated as a separate, retryable condition on top (X3 item 1).
 *
 * The ledger is deliberately NOT part of the frozen `HistoryService` surface — `service.ts`
 * owns the single instance per service and only exposes its totals through `diag().fds`.
 */

export type FdKind = "gen" | "pin" | "temp";

export interface FdLedger {
  /** Synchronous, never blocks/queues. `false` ⇒ caller must not open anything for this request. */
  reserve(n: number, kind: FdKind): boolean;
  /** Must be called exactly once per successful `reserve()` of the same `(n, kind)` — see X3 #1/#2. */
  release(n: number, kind: FdKind): void;
  counts(): { gen: number; pin: number; temp: number; max: number };
}

export function createFdLedger(max: number): FdLedger {
  const counts = { gen: 0, pin: 0, temp: 0 };
  const total = (): number => counts.gen + counts.pin + counts.temp;
  return {
    reserve(n, kind) {
      if (n <= 0) return true;
      if (total() + n > max) return false;
      counts[kind] += n;
      return true;
    },
    release(n, kind) {
      if (n <= 0) return;
      counts[kind] = Math.max(0, counts[kind] - n);
    },
    counts() {
      return { gen: counts.gen, pin: counts.pin, temp: counts.temp, max };
    },
  };
}
