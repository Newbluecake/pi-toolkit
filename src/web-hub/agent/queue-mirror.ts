/**
 * Queue mirror (plan §4.4, D6).
 *
 * pi has no `queue_update` extension event (`_emitQueueUpdate` only reaches
 * the internal app bus, `agent-session.js:502-508`), so this mirror is fed
 * entirely from the events web-hub already forwards: `input` (enqueue),
 * `message_start{role:"user"}` (dequeue), and the 1 Hz `hasPendingMessages()`
 * sample (clear on drain — covers TUI Esc / abort / any other queue-clearing
 * path that fires no event at all).
 */
import type { QueueItemWire } from "../protocol/messages.js";

export type QueueSource = QueueItemWire["source"];

export interface QueueMirrorDeps {
  now?: () => number;
  /** Wire clip length in characters (plan: "截 200 字符"). */
  clipChars?: number;
  maxItems?: number;
}

export interface QueueMirror {
  items(): readonly QueueItemWire[];
  /** One-shot: returns and clears the cmdIds dropped since the last call (StatusInfo.queueDropped
   * "仅下一帧携带"). */
  takeDropped(): string[];
  enqueue(entry: { text: string; deliver: "steer" | "followUp"; source: QueueSource; cmdId?: string }): QueueItemWire;
  /** FIFO dequeue by exact text: steer first, then followUp (K17 fallback order). */
  dequeueByText(text: string): QueueItemWire | undefined;
  /** `hasPendingMessages()===false` sample (§4.4 row 3): clears everything and records any
   * web-sourced cmdIds as dropped. A no-op while pending is still true or the mirror is empty. */
  clearIfEmpty(hasPending: boolean): QueueItemWire[];
  /** Unconditional clear (§4.4 row 4: session_start/detach). Does not touch `takeDropped`'s
   * bookkeeping — callers decide what a session-boundary clear means for their own state. */
  clearAll(): QueueItemWire[];
  dispose(): void;
}

let idCounter = 0;

export function createQueueMirror(deps: QueueMirrorDeps = {}): QueueMirror {
  const now = deps.now ?? Date.now;
  const clipChars = deps.clipChars ?? 200;
  const maxItems = deps.maxItems ?? 32;
  let queue: QueueItemWire[] = [];
  let dropped: string[] = [];

  return {
    items: () => queue.slice(),
    takeDropped: () => {
      const d = dropped;
      dropped = [];
      return d;
    },
    enqueue(entry) {
      idCounter += 1;
      const item: QueueItemWire = {
        id: `wq${idCounter}`,
        text: entry.text.length > clipChars ? entry.text.slice(0, clipChars) : entry.text,
        deliver: entry.deliver,
        source: entry.source,
        at: now(),
      };
      if (entry.cmdId !== undefined) item.cmdId = entry.cmdId;
      queue.push(item);
      if (queue.length > maxItems) queue.shift();
      return item;
    },
    dequeueByText(text) {
      let idx = queue.findIndex((q) => q.deliver === "steer" && q.text === text);
      if (idx === -1) idx = queue.findIndex((q) => q.deliver === "followUp" && q.text === text);
      if (idx === -1) return undefined;
      const [item] = queue.splice(idx, 1);
      return item;
    },
    clearIfEmpty(hasPending) {
      if (hasPending || queue.length === 0) return [];
      const cleared = queue;
      queue = [];
      for (const item of cleared) if (item.cmdId !== undefined) dropped.push(item.cmdId);
      return cleared;
    },
    clearAll() {
      const cleared = queue;
      queue = [];
      return cleared;
    },
    dispose() {
      queue = [];
      dropped = [];
    },
  };
}
