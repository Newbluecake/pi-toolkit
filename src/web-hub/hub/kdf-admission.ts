/**
 * `KdfAdmissionPort` implementation (plan §6.2, LC): a token-bucket admission
 * rate (2/s normal, 0.5/s tightened, capacity 10) gating two fairness
 * queues — `fresh` (4 reserved waiter slots) and `tainted` (24) — with a
 * hard per-IP cap of one outstanding waiter across both queues, a 20s max
 * wait, and alternating service once both queues have waiters (fresh served
 * first on each tie so it gets *at least* half the tokens, per §6.2's
 * fairness table). This governs *admission* into a KDF run slot; the actual
 * KDF pool's own concurrency=2/64MiB budget (§5.1) is `kdf.ts`'s (LS)
 * separate concern — `release()` here is a no-op (queueing, not the
 * concurrency semaphore, is what this port arbitrates per §5.1's own "排队
 * 由 §6.2 的准入队列负责").
 *
 * Capacity/timeout rejections never call `LoginLimiterPort.fail` (§6.2
 * "容量或超时导致的 429 不记污点") — that is the caller's (`lan-auth.ts`)
 * job to honor, not this module's.
 */
import type { KdfAdmissionPort, PortOptions } from "./ports.js";

export const KDF_ADMISSION = {
  capacity: 10,
  rateNormalPerMs: 2 / 1000,
  rateTightenedPerMs: 0.5 / 1000,
  freshCap: 4,
  taintedCap: 24,
  maxWaitMs: 20_000,
  timeoutRetryAfterMs: 2_000,
  capacityRetryAfterMs: 2_000,
} as const;

interface Waiter {
  clientIp: string;
  fresh: boolean;
  resolve: (v: { ok: true; release: () => void } | { ok: false; retryAfterMs: number }) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export function createKdfAdmission(deps: { now: () => number; isTightened: () => boolean }): KdfAdmissionPort {
  const { now, isTightened } = deps;
  let tokens: number = KDF_ADMISSION.capacity;
  let lastRefill = now();
  const freshQ: Waiter[] = [];
  const taintedQ: Waiter[] = [];
  const waitingIps = new Set<string>();
  let lastServedFresh = false;

  function refill(): void {
    const t = now();
    const elapsed = Math.max(0, t - lastRefill);
    const rate = isTightened() ? KDF_ADMISSION.rateTightenedPerMs : KDF_ADMISSION.rateNormalPerMs;
    tokens = Math.min(KDF_ADMISSION.capacity, tokens + elapsed * rate);
    lastRefill = t;
  }

  function removeWaiter(q: Waiter[], w: Waiter): void {
    const i = q.indexOf(w);
    if (i >= 0) q.splice(i, 1);
    waitingIps.delete(w.clientIp);
    clearTimeout(w.timer);
    if (w.signal !== undefined && w.onAbort !== undefined) w.signal.removeEventListener("abort", w.onAbort);
  }

  function grant(q: Waiter[], w: Waiter): void {
    removeWaiter(q, w);
    tokens -= 1;
    w.resolve({ ok: true, release: () => {} });
  }

  function pickQueue(): Waiter[] | undefined {
    const freshHas = freshQ.length > 0;
    const taintedHas = taintedQ.length > 0;
    if (freshHas && taintedHas) {
      // Alternate, fresh-first on ties, so fresh gets >= 50% of served slots (§6.2).
      const serveFresh = !lastServedFresh;
      lastServedFresh = serveFresh;
      return serveFresh ? freshQ : taintedQ;
    }
    if (freshHas) return freshQ;
    if (taintedHas) return taintedQ;
    return undefined;
  }

  function processQueue(): void {
    refill();
    for (;;) {
      if (tokens < 1) return;
      const q = pickQueue();
      if (q === undefined) return;
      const w = q[0]!;
      grant(q, w);
    }
  }

  /** Background pump so a queued waiter is served once tokens refill even if no *new* `acquire`
   * call happens to trigger `processQueue()` (production traffic naturally does; tests and quiet
   * periods should not have to rely on that). Interval only runs while a waiter is queued. */
  let pump: ReturnType<typeof setInterval> | undefined;
  function ensurePump(): void {
    if (pump !== undefined) return;
    pump = setInterval(() => {
      processQueue();
      if (freshQ.length === 0 && taintedQ.length === 0 && pump !== undefined) {
        clearInterval(pump);
        pump = undefined;
      }
    }, 50);
    pump.unref?.();
  }

  function acquire(
    clientIp: string,
    fresh: boolean,
    opts?: PortOptions,
  ): Promise<{ ok: true; release: () => void } | { ok: false; retryAfterMs: number }> {
    refill();
    if (waitingIps.has(clientIp)) {
      return Promise.resolve({ ok: false, retryAfterMs: KDF_ADMISSION.capacityRetryAfterMs });
    }
    const q = fresh ? freshQ : taintedQ;
    const cap = fresh ? KDF_ADMISSION.freshCap : KDF_ADMISSION.taintedCap;
    if (q.length >= cap) {
      return Promise.resolve({ ok: false, retryAfterMs: KDF_ADMISSION.capacityRetryAfterMs });
    }
    return new Promise((resolve) => {
      const w: Waiter = {
        clientIp,
        fresh,
        resolve,
        timer: setTimeout(() => {
          removeWaiter(q, w);
          resolve({ ok: false, retryAfterMs: KDF_ADMISSION.timeoutRetryAfterMs });
        }, KDF_ADMISSION.maxWaitMs),
      };
      w.timer.unref?.();
      const signal = opts?.signal;
      if (signal !== undefined) {
        if (signal.aborted) {
          resolve({ ok: false, retryAfterMs: 0 });
          return;
        }
        w.signal = signal;
        w.onAbort = () => {
          removeWaiter(q, w);
          resolve({ ok: false, retryAfterMs: 0 });
        };
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      waitingIps.add(clientIp);
      q.push(w);
      processQueue();
      if (freshQ.length > 0 || taintedQ.length > 0) ensurePump();
    });
  }

  return { acquire };
}
