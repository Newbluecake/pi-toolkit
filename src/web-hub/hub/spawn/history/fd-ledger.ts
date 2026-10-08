/**
 * web-hub session-history plan v3.3 W1 ("全局 fd 账本取代按槽位计数"): a private, in-process
 * ledger counting ACTUAL fd reservations by kind (`gen` | `pin` | `temp`), capped at
 * `HISTORY_FD_MAX`. `reserve()` is synchronous and never queues — a request that cannot reserve
 * degrades immediately (list page `partial:{busy}`, POST 503 `busy`); it is the HARD upper bound,
 * with EMFILE/ENFILE from the OS treated as a separate, retryable condition on top (X3 item 1).
 *
 * The ledger is deliberately NOT part of the frozen `HistoryService` surface — `service.ts`
 * owns the single instance per service and only exposes its totals through `diag().fds`.
 *
 * v3.4 X3.1: `release()` is assert-and-report, never silently-clamp. An over-release (a
 * `release()` that would drive its kind's count below zero) must be IMPOSSIBLE by construction —
 * gen fds are bound to owner records with a synchronous CAS in `generation.ts` (`closeOwned`),
 * and every other kind pairs one release with one successful reserve inside a single call
 * frame. The zero-clamp stays purely as a defensive guard so a hypothetical future bug cannot
 * poison unrelated kinds' admission, but each occurrence is counted (`overRelease()`) and
 * warned about — the X3.1 tests assert the counter stays 0 across every path.
 */

export type FdKind = "gen" | "pin" | "temp";

export interface FdLedger {
  /** Synchronous, never blocks/queues. `false` ⇒ caller must not open anything for this request. */
  reserve(n: number, kind: FdKind): boolean;
  /** Must be called exactly once per successful `reserve()` of the same `(n, kind)` — see X3 #1/#2
   * and the v3.4 X3.1 note above: an over-release is counted by `overRelease()` and warned
   * about (never silently clamped away). */
  release(n: number, kind: FdKind): void;
  counts(): { gen: number; pin: number; temp: number; max: number };
  /** v3.4 X3.1 (test/internal accessor): how many `release()` calls have over-released so far.
   * NOT part of the frozen `HistoryService.diag().fds` shape — `ports.ts` has no slot for it,
   * so the counter stays internal to the ledger and is exposed here for the X3.1 tests
   * (`generation.test.ts`'s dispose-during-advance race; the pin/temp lifecycles in
   * `fd-ledger.test.ts`). */
  overRelease(): number;
}

export function createFdLedger(max: number): FdLedger {
  const counts = { gen: 0, pin: 0, temp: 0 };
  let overReleaseCount = 0;
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
      if (counts[kind] < n) {
        overReleaseCount += 1;
        console.warn(
          `[web-hub history] fd-ledger over-release: kind=${kind} n=${n} count=${counts[kind]} — ` +
            `release() must pair 1:1 with a successful reserve() (v3.4 X3.1)`,
        );
      }
      counts[kind] = Math.max(0, counts[kind] - n);
    },
    counts() {
      return { gen: counts.gen, pin: counts.pin, temp: counts.temp, max };
    },
    overRelease() {
      return overReleaseCount;
    },
  };
}
