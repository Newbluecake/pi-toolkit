/** P50's only activity owner is createHumanDispatchProof's host-only closure.
 * Consumers must never synthesize an idle snapshot from an instantaneous idle check. */
export interface MemoryActivitySnapshot {
  readonly generation: number;
  readonly lastActivityAt: number;
  readonly running: boolean;
  readonly toolsInFlight: number;
  readonly liveIdle: boolean | undefined;
  readonly hasPendingMessages: boolean | undefined;
}
export interface MemoryActivityPort {
  snapshot(now: number): MemoryActivitySnapshot;
  /** Natural activity notifications, not a polling loop or another hook owner. */
  subscribe?(listener: () => void): () => void;
}
export interface MemoryActivityRecorder {
  noteToolCall(toolCallId: string, now: number): void;
  noteToolResult(toolCallId: string, now: number): void;
  noteMemoryWrite(now: number): void;
}
export type MemoryActivityOwner = MemoryActivityPort & MemoryActivityRecorder;
