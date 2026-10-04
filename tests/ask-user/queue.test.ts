/**
 * P1 queue unit tests (plan §5.3): synchronous fast path, FIFO promotion, early wake
 * (abort / interrupt / remote) while queued.
 */
import { describe, expect, it } from "vitest";
import { createAskQueue, type QueueGrant } from "../../src/ask-user/queue.js";

async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function track(promise: Promise<QueueGrant>): { grants: QueueGrant[] } {
  const grants: QueueGrant[] = [];
  void promise.then((grant) => grants.push(grant));
  return { grants };
}

describe("ask_user FIFO queue", () => {
  it("tryAcquire is synchronous when idle and contended while held", () => {
    const queue = createAskQueue();
    expect(queue.tryAcquire()).toBe(true);
    expect(queue.tryAcquire()).toBe(false);
    queue.release();
    expect(queue.tryAcquire()).toBe(true);
  });

  it("promotes waiters in FIFO order, one per release", async () => {
    const queue = createAskQueue();
    expect(queue.tryAcquire()).toBe(true);
    const w1 = track(queue.enqueue().promise);
    const w2 = track(queue.enqueue().promise);
    const w3 = track(queue.enqueue().promise);
    expect(queue.size()).toBe(3);
    queue.release();
    await flush();
    expect(w1.grants).toEqual([{ kind: "acquired" }]);
    expect(w2.grants).toEqual([]);
    queue.release();
    await flush();
    expect(w2.grants).toEqual([{ kind: "acquired" }]);
    expect(w3.grants).toEqual([]);
    queue.release();
    await flush();
    expect(w3.grants).toEqual([{ kind: "acquired" }]);
    expect(queue.size()).toBe(0);
    queue.release(); // frees the mutex for real
    expect(queue.tryAcquire()).toBe(true);
  });

  it("wake dequeues a waiter with the early outcome; release skips it", async () => {
    const queue = createAskQueue();
    expect(queue.tryAcquire()).toBe(true);
    const h1 = queue.enqueue();
    const h2 = queue.enqueue();
    const t1 = track(h1.promise);
    const t2 = track(h2.promise);
    h1.wake("interrupted");
    await flush();
    expect(t1.grants).toEqual([{ kind: "interrupted" }]);
    expect(queue.size()).toBe(1);
    queue.release();
    await flush();
    // h2 got the mutex — NOT h1's early outcome.
    expect(t2.grants).toEqual([{ kind: "acquired" }]);
  });

  it("wake is a no-op once the waiter settled", async () => {
    const queue = createAskQueue();
    expect(queue.tryAcquire()).toBe(true);
    const handle = queue.enqueue();
    const t = track(handle.promise);
    handle.wake("aborted");
    handle.wake("remote");
    await flush();
    expect(t.grants).toEqual([{ kind: "aborted" }]);
  });

  it("wake after promotion does not steal the mutex", async () => {
    const queue = createAskQueue();
    expect(queue.tryAcquire()).toBe(true);
    const handle = queue.enqueue();
    const t = track(handle.promise);
    queue.release(); // promotes the waiter
    await flush();
    expect(t.grants).toEqual([{ kind: "acquired" }]);
    handle.wake("aborted"); // too late: the waiter owns the mutex now
    await flush();
    expect(t.grants).toEqual([{ kind: "acquired" }]);
    expect(queue.tryAcquire()).toBe(false); // still held by the promoted waiter
    queue.release();
    expect(queue.tryAcquire()).toBe(true);
  });
});
