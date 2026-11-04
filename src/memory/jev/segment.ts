// Segment record for Jev injections (jev-arch §6.1.5–§6.1.6, jev-plan J6).
//
// A "segment" is the stretch of context between two compactions. Inside one
// segment every entry is injected at most once (dedup) and the total is
// capped at SEGMENT_MAX_INJECTED. (The gate latch bookkeeping was removed
// with the gate feature, 2026-11.) The durable source of truth is the
// session branch: every injection appends a `subagent:memory-recall` custom
// entry (`MemoryRecallEntryV1`), and `seed` rebuilds this state by scanning
// the branch — so `/reload` and resume never re-inject what the model
// already saw.
//
// The instance lives in the `wireJev` closure (I4). This file deliberately
// stays pi-free even though the boundary test exempts it: the branch is read
// through the structural `BranchEntryLike` shape.

import {
  MEMORY_RECALL_CUSTOM_TYPE,
  SEGMENT_MAX_INJECTED,
  type EntryHash,
  type InjectLayer,
  type MemoryRecallEntryV1,
} from "./contracts.js";

/** Structural subset of pi's `SessionEntry` the segment scan needs. */
export interface BranchEntryLike {
  readonly type?: string;
  readonly id?: string;
  readonly customType?: string;
  readonly data?: unknown;
}

export interface SegmentStats {
  readonly byLayer: Readonly<Partial<Record<InjectLayer, number>>>;
  readonly total: number;
}

/** B-layer work left over after a compaction (§6.1.5). */
export interface PendingReinject {
  readonly compactionId: string;
  /** Most recent first, ≤3 hashes from the previous segment. */
  readonly hashes: readonly EntryHash[];
}

export interface SegmentState {
  /** Rebuild injected state from the branch (idempotent). */
  seed(branch: readonly BranchEntryLike[]): void;
  /** Record an injection; returns the hashes actually accepted (not yet
   *  injected, within the cap) — callers inject exactly those. */
  markInjected(layer: InjectLayer, hashes: readonly EntryHash[]): readonly EntryHash[];
  isInjected(hash: EntryHash): boolean;
  /** A compaction happened: the current segment becomes "previous", dedup
   *  and the cap reset. Returns the B-layer work (may be empty). */
  resetOnCompaction(compactionId: string): PendingReinject;
  /** B-layer work not yet done for the latest compaction, if any. */
  pendingReinject(): PendingReinject | undefined;
  /** Mark the B layer done for `compactionId`. */
  markReinjected(compactionId: string): void;
  /** Most recent `n` injected hashes of the CURRENT segment, newest first. */
  lastInjected(n: number): readonly EntryHash[];
  count(): number;
  /** True once the cap is reached — injections stop for the segment. */
  full(): boolean;
  /** Slots left before `full()` (memory-predict plan §2.1 segment.ts addition). */
  remaining(): number;
  compactionId(): string | undefined;
  stats(): SegmentStats;
}

const B_LAYER_MAX = 3;

function asRecall(entry: BranchEntryLike): MemoryRecallEntryV1 | undefined {
  if (entry.type !== "custom" || entry.customType !== MEMORY_RECALL_CUSTOM_TYPE) return undefined;
  const d = entry.data as Partial<MemoryRecallEntryV1> | undefined;
  if (d === undefined || d === null || typeof d !== "object" || d.v !== 1) return undefined;
  if (!Array.isArray(d.keys)) return undefined;
  return d as MemoryRecallEntryV1;
}

function uniqueRecent(order: readonly EntryHash[], n: number): EntryHash[] {
  const out: EntryHash[] = [];
  for (let i = order.length - 1; i >= 0 && out.length < n; i--) {
    const h = order[i]!;
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

export function createSegmentState(): SegmentState {
  let injected = new Set<EntryHash>();
  let order: EntryHash[] = [];
  let byLayer: Partial<Record<InjectLayer, number>> = {};
  let currentCompaction: string | undefined;
  let pending: PendingReinject | undefined;

  const clearSegment = (): void => {
    injected = new Set();
    order = [];
    byLayer = {};
  };

  const accept = (layer: InjectLayer, hashes: readonly EntryHash[]): EntryHash[] => {
    const out: EntryHash[] = [];
    for (const h of hashes) {
      if (injected.size + out.length >= SEGMENT_MAX_INJECTED) break;
      if (injected.has(h) || out.includes(h)) continue;
      out.push(h);
    }
    for (const h of out) {
      injected.add(h);
      order.push(h);
    }
    if (out.length > 0) byLayer[layer] = (byLayer[layer] ?? 0) + out.length;
    return out;
  };

  return {
    seed(branch) {
      let lastIdx = -1;
      let prevIdx = -1;
      for (let i = 0; i < branch.length; i++) {
        if (branch[i]?.type === "compaction") {
          prevIdx = lastIdx;
          lastIdx = i;
        }
      }
      const lastId = lastIdx === -1 ? undefined : (branch[lastIdx]?.id ?? `idx:${lastIdx}`);
      clearSegment();
      currentCompaction = lastId;
      let bDone = false;
      for (let i = lastIdx + 1; i < branch.length; i++) {
        const rec = asRecall(branch[i]!);
        if (rec === undefined) continue;
        if (rec.bFor !== undefined && rec.bFor === lastId) bDone = true;
        accept(rec.layer, rec.keys);
      }
      pending = undefined;
      if (lastId !== undefined && !bDone) {
        const prevOrder: EntryHash[] = [];
        for (let i = prevIdx + 1; i < lastIdx; i++) {
          const rec = asRecall(branch[i]!);
          if (rec !== undefined) prevOrder.push(...rec.keys);
        }
        const hashes = uniqueRecent(prevOrder, B_LAYER_MAX);
        if (hashes.length > 0) pending = { compactionId: lastId, hashes };
      }
    },
    markInjected(layer, hashes) {
      return accept(layer, hashes);
    },
    isInjected: (hash) => injected.has(hash),
    resetOnCompaction(compactionId) {
      if (compactionId === currentCompaction && pending?.compactionId === compactionId) return pending;
      const hashes = uniqueRecent(order, B_LAYER_MAX);
      clearSegment();
      currentCompaction = compactionId;
      pending = { compactionId, hashes };
      return pending;
    },
    pendingReinject: () => (pending !== undefined && pending.hashes.length > 0 ? pending : undefined),
    markReinjected(compactionId) {
      if (pending?.compactionId === compactionId) pending = undefined;
    },
    lastInjected: (n) => uniqueRecent(order, n),
    count: () => injected.size,
    full: () => injected.size >= SEGMENT_MAX_INJECTED,
    remaining: () => Math.max(0, SEGMENT_MAX_INJECTED - injected.size),
    compactionId: () => currentCompaction,
    stats: () => ({ byLayer: { ...byLayer }, total: injected.size }),
  };
}

/** The `subagent:memory-recall` record appended for every injection. */
export function recallRecord(
  layer: InjectLayer,
  keys: readonly EntryHash[],
  opts: { bFor?: string } = {},
): MemoryRecallEntryV1 {
  return {
    v: 1,
    layer,
    keys: [...keys],
    ...(opts.bFor === undefined ? {} : { bFor: opts.bFor }),
  };
}
