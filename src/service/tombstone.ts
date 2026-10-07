import type { RunId, RunSnapshot, TimeoutPolicy } from "../core/types.js";

export interface Tombstone {
  readonly runId: RunId;
  readonly generation: number;
  readonly sessionFile: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /**
   * Timeout-policy persisted from `snapshot.diag.timeoutPolicy` at eviction
   * (agent-explicit-timeout-extend plan §2.7): a resume of an evicted run
   * within the TTL inherits the original run's policy. Absent on old entries.
   * Type-only in this batch; `register()` copies it in P1.
   */
  readonly timeoutPolicy?: TimeoutPolicy;
}

/** In-memory terminal handle index. Entries are intentionally bounded by TTL. */
export class TombstoneStore {
  private readonly entries = new Map<string, Tombstone>();
  constructor(
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly now = () => Date.now(),
  ) {}

  register(snapshot: RunSnapshot): void {
    const sessionFile = snapshot.diag.sessionFile;
    if (!sessionFile) return;
    const createdAt = this.now();
    this.entries.set(snapshot.runId, {
      runId: snapshot.runId,
      generation: snapshot.generation,
      sessionFile,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      // §2.7：策略作为 run 的持久事实随逐出记录存活，TTL 内的 resume 继承它；
      // 旧快照缺字段就不拷，读侧对缺席走中性文案。
      ...(snapshot.diag.timeoutPolicy === undefined ? {} : { timeoutPolicy: snapshot.diag.timeoutPolicy }),
    });
  }
  has(runId: RunId): boolean {
    this.cleanup();
    return this.entries.has(runId);
  }
  get(runId: RunId): Tombstone | undefined {
    this.cleanup();
    return this.entries.get(runId);
  }
  resolve(handle: string): Tombstone | undefined {
    this.cleanup();
    return this.entries.get(handle) ?? [...this.entries.values()].find((entry) => entry.sessionFile === handle);
  }
  cleanup(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }
  list(): readonly Tombstone[] {
    this.cleanup();
    return [...this.entries.values()];
  }
}
