/**
 * fabric-thread P1 (arch r3 §6.5 缓冲冲刷): the per-subscription event buffer — ≤ 4 events,
 * ≤ 32 KiB of ENCAPSULATED bytes (§9.1 wrapper text), FIFO. Holds events for a subscriber whose
 * run is still queued/starting until the first `onSnapshot(status==="running")` flush (§5.3,
 * review #5 — NOT `subagent:started`, which fires before the run is steerable).
 *
 * `deliveredAt` (the TTL anchor, §8.2 S) is written by the engine when the event's routed reply
 * fires — an event is buffered BEFORE its reply exists, so entries land with `undefined` and are
 * patched via {@link ThreadBuffer.setDeliveredAt} the moment the reply is sent.
 */
import { utf8ByteLength } from "../../web-hub/protocol/thread.js";
import type { ThreadEventId, ThreadHandle } from "./types.js";

export const THREAD_BUFFER_MAX_EVENTS = 4;
export const THREAD_BUFFER_MAX_BYTES = 32 * 1024;

export interface BufferedThreadEvent {
  readonly eventId: ThreadEventId;
  readonly h: ThreadHandle;
  readonly sentAt: number;
  /** §9.1 encapsulated wrapper text — the exact bytes the flush will steer. */
  readonly text: string;
  readonly bytes: number;
  /** routed-reply time (§6.5 anchor for the startTimeoutMin TTL); patched on reply. */
  deliveredAt: number | undefined;
}

export type BufferPushResult = { ok: true } | { ok: false; reason: "events_full" | "bytes_full" };

export class ThreadBuffer {
  private queue: BufferedThreadEvent[] = [];
  private byteTotal = 0;

  get length(): number {
    return this.queue.length;
  }

  get bytes(): number {
    return this.byteTotal;
  }

  /** §6.5: 超出时这个事件对该订阅者记 `none`（调用前确定）— the CALLER records the outcome. */
  push(eventId: ThreadEventId, h: ThreadHandle, sentAt: number, text: string): BufferPushResult {
    if (this.queue.length >= THREAD_BUFFER_MAX_EVENTS) return { ok: false, reason: "events_full" };
    const bytes = utf8ByteLength(text);
    if (this.byteTotal + bytes > THREAD_BUFFER_MAX_BYTES) return { ok: false, reason: "bytes_full" };
    this.queue.push({ eventId, h, sentAt, text, bytes, deliveredAt: undefined });
    this.byteTotal += bytes;
    return { ok: true };
  }

  /** FIFO drain — flush start, or the §6.5 none-sweep on unsubscribe/handback/close/TTL/run-terminal. */
  drain(): BufferedThreadEvent[] {
    const out = this.queue;
    this.queue = [];
    this.byteTotal = 0;
    return out;
  }

  /** Patch the TTL anchor once the event's routed reply fires. No-op for already-drained entries. */
  setDeliveredAt(eventId: ThreadEventId, deliveredAt: number): void {
    for (const e of this.queue) {
      if (e.eventId === eventId) e.deliveredAt = deliveredAt;
    }
  }

  /** §6.5 TTL: 最早一个缓冲事件到期 ⇒ 订阅结束（start_timeout）。 */
  earliestDeliveredAt(): number | undefined {
    let earliest: number | undefined;
    for (const e of this.queue) {
      if (e.deliveredAt !== undefined && (earliest === undefined || e.deliveredAt < earliest)) {
        earliest = e.deliveredAt;
      }
    }
    return earliest;
  }

  /** The engine's per-sub TTL timer target (earliest anchor + S); `undefined` while any entry
   * still lacks its anchor (its reply has not fired yet — the reply arms the timer). */
  expiryAt(startTimeoutMs: number): number | undefined {
    if (this.queue.length === 0) return undefined;
    if (this.queue.some((e) => e.deliveredAt === undefined)) return undefined;
    const earliest = this.earliestDeliveredAt();
    return earliest === undefined ? undefined : earliest + startTimeoutMs;
  }
}
