/**
 * worktree-diff plan §1.10 (D3): the changeset cache + single-flight.
 *
 * The hub caches EXACTLY ONE thing (I6): the changeset — paths + statuses + flags, ≤5 s TTL,
 * never git output bodies and never file content. The key is
 *   `ids (dev:ino of W/gitdir/commondir) \0 C0.oid \0 indexStat \0 attrSig \0 untracked`
 * — carrying the REQUEST'S OWN C0 oid (I15: a hit is only possible when the oid equals), so a
 * `file` request's base check is always judged against this request's C0, never a cached value.
 *
 * Single-flight: an in-flight computation is joined by concurrent same-key requests
 * (`joined:true` in each request's own audit line; each request still answers itself). The
 * shared execution owns its own AbortController; a joiner leaving decrements the refcount and
 * the LAST leaver aborts it (§1.10). It runs under a `PinSet.withLoan` on the initiating
 * request's pins (wired by routes.ts), so it may outlive that request's ⑬.
 *
 * Bounds: TTL `WTDIFF_CHANGESET_TTL_MS` (5 s), LRU 8 keys, total cached bytes ≤ 2 MiB (a value
 * that alone exceeds the cap is computed but simply not stored).
 */

import type { WtDiffStatus } from "../../protocol/worktree-diff.js";
import { WTDIFF_CHANGESET_TTL_MS } from "../../protocol/worktree-diff.js";
import type { PinIds } from "./git.js";

export interface ChangesetEntry {
  path: string;
  orig?: string;
  status: WtDiffStatus;
  /** managed by a filter driver (or check-attr did not cover it): listed, never requestable */
  filtered?: true;
}

export interface ChangesetValue {
  base: string;
  /** order = git status output order; NO numstat counts (those merge per-request, §1.7 ⑩f) */
  entries: ChangesetEntry[];
  /** parsed, NOT-hidden count (denylist hits never counted, D14); lower bound under limitsStatus */
  totalVisible: number;
  limitsStatus: boolean;
  limitsFiles: boolean;
  untrackedSkipped?: true;
  attrPartial?: true;
}

export interface SharedExec {
  signal: AbortSignal;
  /** §1.10: the shared execution's deadline — the FIRST joiner's. */
  deadline: import("../req-deadline.js").ReqDeadline;
}

interface InflightExec<T> {
  ctl: AbortController;
  deadline: import("../req-deadline.js").ReqDeadline;
  refcount: number;
  promise: Promise<T>;
}

export interface AcquiredExec<T> {
  promise: Promise<T>;
  joined: boolean;
  cached: boolean;
  /** idempotent; the last leaver of a shared exec aborts it (§1.10) */
  release(): void;
}

/** §1.10 键构成: `ids \0 oid \0 indexStat \0 attrSig \0 untracked` (test-pinned order). */
export function changesetKeyOf(
  ids: PinIds,
  oid: string,
  indexStat: string,
  attrSig: string,
  untracked: "all" | "no",
): string {
  return [
    `${ids.wt.dev}:${ids.wt.ino}`,
    `${ids.git.dev}:${ids.git.ino}`,
    `${ids.common.dev}:${ids.common.ino}`,
    oid,
    indexStat,
    attrSig,
    untracked,
  ].join("\0");
}

const CACHE_LRU_MAX = 8;
const CACHE_TOTAL_BYTES = 2 * 1024 * 1024;

interface CacheEntry {
  value: ChangesetValue;
  at: number;
  bytes: number;
}

/** The generic TTL/LRU/single-flight engine — the changeset cache and the C4 in-flight join
 * (join-only, never cached: git output bodies are never stored, I6) share it. */
export class SingleFlightCache<T> {
  private readonly cache = new Map<string, CacheEntryLike<T>>();
  private readonly inflight = new Map<string, InflightExec<T>>();
  private cachedBytes = 0;

  constructor(
    private readonly deps: {
      ttlMs: number;
      lruMax: number;
      totalBytes: number;
      /** 0 ⇒ join-only (never stored). */
      store: boolean;
      now(): number;
    },
  ) {}

  acquire(
    key: string,
    leaderDeadline: import("../req-deadline.js").ReqDeadline,
    compute: (exec: SharedExec) => Promise<T>,
  ): AcquiredExec<T> {
    const now = this.deps.now();
    if (this.deps.store) {
      const hit = this.cache.get(key);
      if (hit !== undefined && now - hit.at <= this.deps.ttlMs) {
        // LRU touch
        this.cache.delete(key);
        this.cache.set(key, hit);
        const p = Promise.resolve(hit.value);
        return { promise: p, joined: false, cached: true, release: () => undefined };
      }
      if (hit !== undefined) this.evict(key);
    }
    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      existing.refcount += 1;
      return {
        promise: existing.promise,
        joined: true,
        cached: false,
        release: () => {
          existing.refcount -= 1;
          if (existing.refcount <= 0 && this.inflight.get(key) === existing) {
            this.inflight.delete(key);
            existing.ctl.abort("single-flight-abandoned");
          }
        },
      };
    }
    const ctl = new AbortController();
    const exec: InflightExec<T> = {
      ctl,
      deadline: leaderDeadline,
      refcount: 1,
      promise: undefined as unknown as Promise<T>, // assigned immediately below
    };
    const promise = compute({ signal: ctl.signal, deadline: exec.deadline }).then(
      (value) => {
        if (this.inflight.get(key) === exec) this.inflight.delete(key);
        if (this.deps.store) this.store(key, value);
        return value;
      },
      (err: unknown) => {
        if (this.inflight.get(key) === exec) this.inflight.delete(key);
        throw err;
      },
    );
    // a leader that races away (request abort) must never turn into an unhandled rejection
    promise.catch(() => undefined);
    exec.promise = promise;
    this.inflight.set(key, exec);
    return {
      promise,
      joined: false,
      cached: false,
      release: () => {
        exec.refcount -= 1;
        if (exec.refcount <= 0 && this.inflight.get(key) === exec) {
          this.inflight.delete(key);
          exec.ctl.abort("single-flight-abandoned");
        }
      },
    };
  }

  /** dispose: abort every shared execution still running (reason "hub-close"). */
  abortAll(reason: string): void {
    for (const exec of [...this.inflight.values()]) exec.ctl.abort(reason);
  }

  size(): { cached: number; inflight: number } {
    return { cached: this.cache.size, inflight: this.inflight.size };
  }

  private store(key: string, value: T): void {
    const bytes = approxBytes(value);
    if (bytes > this.deps.totalBytes) return;
    const prev = this.cache.get(key);
    if (prev !== undefined) this.evict(key);
    while (this.cache.size >= this.deps.lruMax || this.cachedBytes + bytes > this.deps.totalBytes) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.evict(oldest);
    }
    this.cache.set(key, { value, at: this.deps.now(), bytes });
    this.cachedBytes += bytes;
  }

  private evict(key: string): void {
    const hit = this.cache.get(key);
    if (hit === undefined) return;
    this.cache.delete(key);
    this.cachedBytes = Math.max(0, this.cachedBytes - hit.bytes);
  }
}

interface CacheEntryLike<T> {
  value: T;
  at: number;
  bytes: number;
}

function approxBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** §1.10 实例工厂: the changeset cache (TTL 5 s, LRU 8, ≤2 MiB, stored). */
export function createChangesetCache(now: () => number): SingleFlightCache<ChangesetValue> {
  return new SingleFlightCache<ChangesetValue>({
    ttlMs: WTDIFF_CHANGESET_TTL_MS,
    lruMax: CACHE_LRU_MAX,
    totalBytes: CACHE_TOTAL_BYTES,
    store: true,
    now,
  });
}
