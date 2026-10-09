/**
 * topic-switch · release queue (plan.md §P3b.5, R-A + 有序屏障).
 *
 * Processes held + newcomer items strictly in order: the HELD item is always first (callers
 * enqueue it before any newcomer can be appended — the reducer only starts emitting `release`
 * once judging/confirming/hopping has already ended). Per item: wait out any in-progress
 * compaction (bounded, "照发" after the bound expires rather than drop it), deliver, then wait a
 * short ordering barrier before moving on to the next item (R5/R12: the barrier is best-effort
 * ordering, never a correctness gate — a timeout here still delivers everything, just possibly
 * out of order).
 *
 * P4 finding (c): `release.current()` is once-only even when it settles `"refused"` (stale ctx /
 * session changed / mid-compaction / this release already consumed by something else) — when
 * that happens this queue falls back to delivering the SAME text through the content path
 * exactly once, so a refused web release never silently drops the request.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Clock } from "../core/clock.js";
import { toContent } from "./hold.js";
import type { HeldPayload } from "./types.js";
import type { WebPromptRelease } from "../web-hub/agent/prompt-gate.js";

export interface ReleaseContentItem {
  kind: "content";
  payload: HeldPayload;
  deliverAs: "steer" | "followUp";
}
export interface ReleaseWebItem {
  kind: "web";
  payload: HeldPayload;
  release: WebPromptRelease;
}
export type ReleaseItem = ReleaseContentItem | ReleaseWebItem;

export interface ReleaseQueueDeps {
  sendUserMessage(content: (TextContent | ImageContent)[], deliverAs: "steer" | "followUp"): void;
  isCompacting(): boolean;
  /** Resolves once `session_compact`/`session_compact_failed` fires, or `timeoutMs` elapses. */
  waitCompactSettled(timeoutMs: number): Promise<void>;
  /** Resolves once the ordering-barrier condition is observed, or `timeoutMs` elapses. */
  waitBarrier(timeoutMs: number): Promise<void>;
  clock: Clock;
  /** Fires whenever the queue transitions between idle and processing (gate `draining`). */
  onDrainChange?(draining: boolean): void;
  /** M2: fires once PER ITEM right after `deliver()` has run for it (content success/throw, web
   *  dispatch, or web-refused content fallback — every path that `deliver()` itself treats as
   *  "this item's one and only send attempt is done", never retried). The caller uses this to mark
   *  the held payload as already-sent so a later `persist-pending` never re-stages it. */
  onSent?(item: ReleaseItem): void;
}

export interface ReleaseQueue {
  enqueue(item: ReleaseItem): void;
  readonly draining: boolean;
  /** Resolves once the queue has fully drained (empty AND the final barrier settled). Already-
   *  drained ⇒ resolves on the next microtask. Used by `wire.ts` to feed `{t:"released"}`. */
  whenDrained(): Promise<void>;
}

const COMPACT_WAIT_MS = 120_000;
const BARRIER_MS = 2_000;

export function createReleaseQueue(deps: ReleaseQueueDeps): ReleaseQueue {
  const pending: ReleaseItem[] = [];
  let running = false;
  let draining = false;
  let drainWaiters: Array<() => void> = [];

  function setDraining(v: boolean): void {
    if (draining === v) return;
    draining = v;
    try {
      deps.onDrainChange?.(v);
    } catch {
      /* best-effort: a broken caller must never wedge the queue */
    }
  }

  async function deliver(item: ReleaseItem): Promise<void> {
    if (item.kind === "content") {
      try {
        deps.sendUserMessage(toContent(item.payload), item.deliverAs);
      } catch {
        /* a synchronous sendUserMessage throw is reported upstream (watchdog/notify), not retried
         * here — retrying could duplicate a message that was already partially delivered. */
      }
      return;
    }
    let outcome: "dispatched" | "refused" = "refused";
    try {
      outcome = item.release.current();
    } catch {
      outcome = "refused";
    }
    if (outcome === "refused") {
      // P4 finding (c): once-only `current()` settling "refused" must not silently drop the
      // request — fall back to the content path exactly once.
      try {
        deps.sendUserMessage(toContent(item.payload), "followUp");
      } catch {
        /* best-effort, same rationale as the content branch above */
      }
    }
  }

  async function drive(): Promise<void> {
    if (running) return;
    running = true;
    setDraining(true);
    while (pending.length > 0) {
      const item = pending.shift()!;
      try {
        if (deps.isCompacting()) await deps.waitCompactSettled(COMPACT_WAIT_MS);
      } catch {
        /* never let a broken compact-wait port stall delivery */
      }
      await deliver(item);
      try {
        deps.onSent?.(item);
      } catch {
        /* best-effort: a broken onSent port must never stall the queue */
      }
      try {
        await deps.waitBarrier(BARRIER_MS);
      } catch {
        /* never let a broken barrier wait stall the queue */
      }
    }
    running = false;
    setDraining(false);
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  return {
    enqueue(item) {
      pending.push(item);
      void drive();
    },
    get draining() {
      return draining;
    },
    whenDrained() {
      if (!running && pending.length === 0) return Promise.resolve();
      return new Promise((resolve) => drainWaiters.push(resolve));
    },
  };
}
