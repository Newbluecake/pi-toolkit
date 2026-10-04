/**
 * P1 (ask-user-async plan §5.3): the per-activate FIFO mutex serializing TUI ask_user dialogs.
 *
 * Approved behavior change: several ask_user calls in one tool batch are presented one at a
 * time in execute-start order, instead of concurrently calling `ui.custom` (which made
 * `showExtensionCustom` clear the first component so its promise never resolved — the batch
 * could only be escaped with Esc).
 *
 * The single-ask fast path is SYNCHRONOUS: `tryAcquire()` succeeds in the same sync segment,
 * so `ui.custom` is called at exactly the same moment as before the queue existed (R1).
 */

export type QueueGrant = { kind: "acquired" } | { kind: "aborted" } | { kind: "interrupted" } | { kind: "remote" };

export interface AskQueueHandle {
  readonly promise: Promise<QueueGrant>;
  /** Resolve the wait early (dequeueing). No-op once the wait has settled. */
  wake(kind: "aborted" | "interrupted" | "remote"): void;
}

export interface AskQueue {
  /** Synchronous fast path: true when the mutex was free and is now held by the caller. */
  tryAcquire(): boolean;
  /** Queue behind the current holder. The returned promise resolves with the grant. */
  enqueue(): AskQueueHandle;
  /** Hand the mutex to the oldest waiter (FIFO) or free it. */
  release(): void;
  /** Number of queued waiters (testing/introspection). */
  size(): number;
}

export function createAskQueue(): AskQueue {
  let held = false;
  interface Entry {
    readonly settle: (grant: QueueGrant) => void;
    settled: boolean;
  }
  // Unpromoted waiters, FIFO order. A promoted waiter (grant "acquired") is removed here and
  // owns the mutex until it calls release().
  const entries: Entry[] = [];
  return {
    tryAcquire() {
      if (held) return false;
      held = true;
      return true;
    },
    enqueue() {
      let resolveFn!: (grant: QueueGrant) => void;
      const promise = new Promise<QueueGrant>((resolve) => {
        resolveFn = resolve;
      });
      const entry: Entry = {
        settled: false,
        settle(grant) {
          if (entry.settled) return;
          entry.settled = true;
          const index = entries.indexOf(entry);
          if (index >= 0) entries.splice(index, 1);
          resolveFn(grant);
        },
      };
      entries.push(entry);
      return {
        promise,
        wake(kind) {
          entry.settle({ kind });
        },
      };
    },
    release() {
      const next = entries.shift();
      if (next) {
        // The mutex transfers directly; `held` stays true.
        next.settle({ kind: "acquired" });
      } else {
        held = false;
      }
    },
    size() {
      return entries.length;
    },
  };
}
