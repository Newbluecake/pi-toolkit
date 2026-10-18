/**
 * Bounded pbbp2 event fragment cache, based on node-sdk @ b188be6 data-cache.ts.
 * R2-i: repeated seq REPLACES the stored bytes. No timers, I/O, JSON parsing,
 * ACK policy or connection generations here; the owner injects a monotonic clock
 * and clears/discards this per-connection instance at a generation boundary.
 */
import { FEISHU_CHUNK_LIMITS, FEISHU_FRAME_LIMITS } from "../../protocol/feishu.js";
import { header, type Frame } from "./frame.js";

export type ChunkRejection =
  | "fragment-meta"
  | "fragment-payload"
  | "fragment-sum"
  | "message-capacity"
  | "message-too-large"
  | "total-too-large"
  | "invalid-clock";

export type ChunkResult =
  | { status: "pending"; duplicate: boolean }
  | { status: "complete"; payload: Uint8Array }
  | { status: "rejected"; reason: ChunkRejection };

interface PartialMessage {
  sum: number;
  parts: Map<number, Uint8Array>;
  bytes: number;
  createdAt: number;
}

export class Fragments {
  private pending = new Map<string, PartialMessage>();
  private total = 0;

  /** Clock must return finite monotonic ms. Non-finite reads expire all and refuse admission. */
  constructor(private readonly now: () => number) {}

  stats(): { messages: number; bytes: number } {
    return { messages: this.pending.size, bytes: this.total };
  }

  clear(): void {
    this.pending.clear();
    this.total = 0;
  }

  private remove(id: string, message: PartialMessage): void {
    this.pending.delete(id);
    this.total -= message.bytes;
  }

  /** Lazy sweep; F3 may also call this on its existing maintenance tick. */
  sweep(): number {
    return this.expire(this.now());
  }

  private expire(now: number): number {
    if (!Number.isFinite(now)) {
      const removed = this.pending.size;
      this.clear();
      return removed;
    }
    let removed = 0;
    for (const [id, message] of this.pending) {
      if (now - message.createdAt >= FEISHU_CHUNK_LIMITS.ttlMs) {
        this.remove(id, message);
        removed++;
      }
    }
    return removed;
  }

  add(frame: Frame): ChunkResult {
    const now = this.now();
    this.expire(now);
    if (!Number.isFinite(now)) return { status: "rejected", reason: "invalid-clock" };
    const id = header(frame, "message_id");
    const sumText = header(frame, "sum");
    const seqText = header(frame, "seq");
    // Headers are decimal wire metadata, not JS numeric expressions/whitespace.
    if (
      !id ||
      new TextEncoder().encode(id).length > FEISHU_FRAME_LIMITS.maxHeaderValueBytes ||
      sumText === undefined ||
      seqText === undefined ||
      !/^\d+$/.test(sumText) ||
      !/^\d+$/.test(seqText)
    )
      return { status: "rejected", reason: "fragment-meta" };
    const sum = Number(sumText);
    const seq = Number(seqText);
    if (
      !Number.isInteger(sum) ||
      sum < 1 ||
      sum > FEISHU_CHUNK_LIMITS.maxSum ||
      !Number.isInteger(seq) ||
      seq < 0 ||
      seq >= sum
    )
      return { status: "rejected", reason: "fragment-meta" };
    if (!(frame.payload instanceof Uint8Array)) return { status: "rejected", reason: "fragment-payload" };
    const payload = frame.payload;
    const cached = this.pending.get(id);
    if (cached && cached.sum !== sum) return { status: "rejected", reason: "fragment-sum" };
    // Complete single-fragment messages are never cached, so partial-set count
    // and aggregate storage caps cannot prevent their immediate delivery.
    if (sum === 1) {
      if (payload.length > FEISHU_CHUNK_LIMITS.maxMessageBytes)
        return { status: "rejected", reason: "message-too-large" };
      return { status: "complete", payload: Uint8Array.from(payload) };
    }
    if (!cached && this.pending.size >= FEISHU_CHUNK_LIMITS.maxMessages)
      return { status: "rejected", reason: "message-capacity" };
    const message: PartialMessage = cached ?? { sum, parts: new Map(), bytes: 0, createdAt: now };
    const previous = message.parts.get(seq);
    const delta = payload.length - (previous?.length ?? 0);
    if (message.bytes + delta > FEISHU_CHUNK_LIMITS.maxMessageBytes)
      return { status: "rejected", reason: "message-too-large" };
    if (this.total + delta > FEISHU_CHUNK_LIMITS.maxTotalBytes)
      return { status: "rejected", reason: "total-too-large" };
    // Check every limit BEFORE copying/mutating: a refused replacement preserves
    // the old fragment and all partial sets; there is no implicit eviction.
    message.parts.set(seq, Uint8Array.from(payload));
    message.bytes += delta;
    this.total += delta;
    this.pending.set(id, message);
    if (message.parts.size !== sum) return { status: "pending", duplicate: previous !== undefined };
    const out = new Uint8Array(message.bytes);
    let offset = 0;
    for (let i = 0; i < sum; i++) {
      const part = message.parts.get(i)!;
      out.set(part, offset);
      offset += part.length;
    }
    this.remove(id, message);
    return { status: "complete", payload: out };
  }
}
