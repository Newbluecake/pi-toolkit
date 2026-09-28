import type { QueueItemWire } from "../protocol/messages.js";
export interface QueueMirror {
  items(): readonly QueueItemWire[];
  dispose(): void;
}
export function createQueueMirror(): QueueMirror {
  return { items: () => [], dispose() {} };
}
