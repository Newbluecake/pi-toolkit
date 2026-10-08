/**
 * web-hub session-history plan v3.2 V1 + v3.3 W2: a per-generation async mutex, explicit FIFO
 * queue of nodes (not a bare promise chain), with deadline-driven cancellation.
 *
 * State machine per node: `queued → running → done` or `queued → cancelled`. A node whose wait
 * outlives its caller's deadline is marked `cancelled` and skipped when its turn in the queue
 * arrives — it never reads or writes anything the lock protects (X3 #3). `release()` is
 * idempotent: calling it on an already-`done`/`cancelled` node is a no-op, so a holder's
 * `finally { lock.release(node) }` is always safe.
 */

export type LockNodeState = "queued" | "running" | "done" | "cancelled";

export interface GenLockNode {
  state: LockNodeState;
}

export interface GenLock {
  /**
   * FIFO-acquire. Resolves with a node once it is this caller's turn (`state === "running"`), or
   * `undefined` if the deadline elapsed first while still queued. The timer is unref'd.
   */
  acquire(remainingMs: number): Promise<GenLockNode | undefined>;
  /** No-op unless `node.state === "running"`. */
  release(node: GenLockNode): void;
}

interface Waiter {
  node: GenLockNode;
  settle(node: GenLockNode | undefined): void;
  timer?: NodeJS.Timeout;
}

export function createGenLock(): GenLock {
  let held = false;
  const queue: Waiter[] = [];

  function handOff(): void {
    while (!held && queue.length > 0) {
      const w = queue.shift();
      if (w === undefined) return;
      if (w.node.state === "cancelled") continue; // skip — never runs
      if (w.timer !== undefined) clearTimeout(w.timer);
      w.node.state = "running";
      held = true;
      w.settle(w.node);
      return;
    }
  }

  return {
    acquire(remainingMs: number): Promise<GenLockNode | undefined> {
      return new Promise((resolve) => {
        const node: GenLockNode = { state: "queued" };
        if (remainingMs <= 0) {
          node.state = "cancelled";
          resolve(undefined);
          return;
        }
        const waiter: Waiter = { node, settle: resolve };
        waiter.timer = setTimeout(() => {
          if (node.state === "queued") {
            node.state = "cancelled";
            resolve(undefined);
          }
        }, remainingMs);
        waiter.timer.unref();
        queue.push(waiter);
        handOff();
      });
    },
    release(node: GenLockNode): void {
      if (node.state !== "running") return; // idempotent: already done/cancelled
      node.state = "done";
      held = false;
      handOff();
    },
  };
}

/**
 * Run `fn` while holding `lock`, within `remainingMs`. Returns `{ ok: true, value }` on a
 * completed run, or `{ ok: false }` if the wait itself was cancelled by the deadline (the
 * caller never entered `fn`). `fn`'s own thrown errors propagate — `release()` still runs via
 * `finally` (every holder is `try { … } finally { release() }`, X3 #3).
 */
export async function withGenLock<T>(
  lock: GenLock,
  remainingMs: number,
  fn: () => Promise<T> | T,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const node = await lock.acquire(remainingMs);
  if (node === undefined) return { ok: false };
  try {
    const value = await fn();
    return { ok: true, value };
  } finally {
    lock.release(node);
  }
}
