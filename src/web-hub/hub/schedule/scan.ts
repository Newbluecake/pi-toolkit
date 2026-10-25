/**
 * scheduled-reports plan r3 §7.6 (H1, r2 after review round 1) — the hub's budgeted read-only
 * scanner over S1's reader.
 *
 * One scan = a chunked CYCLICAL walk of the pinned store root: starting at `startAt` (the
 * rotation cursor a timed-out pass leaves behind), wrapping around to index 0, so every pass
 * covers the whole listing and a slow prefix can never starve the tail (review r1 #10). Between
 * sessions the loop yields to the event loop (setImmediate) and re-checks the cooperative
 * deadline (default 2s) and the generation fence, so a late/stale scan abandons its result
 * instead of publishing it; a timed-out pass reports `nextStart` (resume position). The
 * per-read IO itself is S1's synchronous, size-bounded, O_NOFOLLOW fd-anchored read — one file
 * at a time (the ≤2-concurrent budget is satisfied by construction). ZERO writes: everything
 * here routes through `src/schedule/core/reader.ts` (pinned read-only by the boundary test).
 */
import type { StoreRoot } from "../../../schedule/core/paths.js";
import {
  listSessionDirs,
  readSessionState,
  readSessionStateById,
  type SessionStateRead,
} from "../../../schedule/core/reader.js";

export const SCHED_SCAN_DEADLINE_MS = 2_000;
export const SCHED_SCAN_MAX_SESSIONS = 64;

export interface ScanSession {
  sessionId: string;
  read: SessionStateRead;
}

export interface ScanResult {
  sessions: ScanSession[];
  /** Root-level failure (vanished/moved/symlinked store dir) — the whole scan degrades. */
  rootDegraded?: string;
  truncated: boolean;
  timedOut: boolean;
  /** Resume position (index into the sorted listing) for the NEXT pass after a timeout. */
  nextStart?: number;
  /** True when the generation fence rejected the result (a newer scan superseded this one). */
  fenced: boolean;
}

export interface ScanOpts {
  deadlineMs?: number;
  /** Generation fence: return early (fenced) once this goes false. */
  isCurrent?: () => boolean;
  maxSessions?: number;
  /** Rotation cursor: index into the sorted listing where this pass starts (wraps around). */
  startAt?: number;
}

const yieldTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function scanStore(root: StoreRoot, opts: ScanOpts = {}): Promise<ScanResult> {
  const deadline = opts.deadlineMs ?? SCHED_SCAN_DEADLINE_MS;
  const isCurrent = opts.isCurrent ?? (() => true);
  const max = opts.maxSessions ?? SCHED_SCAN_MAX_SESSIONS;
  const startedAt = Date.now();
  const listing = listSessionDirs(root);
  if (listing.kind === "degraded") {
    return {
      sessions: [],
      rootDegraded: `${listing.reason}: ${listing.detail}`,
      truncated: false,
      timedOut: false,
      fenced: !isCurrent(),
    };
  }
  const dirs = listing.dirs;
  const start = dirs.length === 0 ? 0 : (((opts.startAt ?? 0) % dirs.length) + dirs.length) % dirs.length;
  const sessions: ScanSession[] = [];
  let timedOut = false;
  let visited = 0;
  for (let step = 0; step < dirs.length; step++) {
    if (!isCurrent()) {
      return { sessions: [], truncated: listing.truncated, timedOut: false, fenced: true };
    }
    if (Date.now() - startedAt > deadline) {
      timedOut = true;
      break;
    }
    const idx = (start + step) % dirs.length;
    const dirName = dirs[idx]!;
    const read = readSessionState(root, dirName);
    visited = step + 1;
    if (read.kind === "absent") continue;
    sessions.push({ sessionId: dirName, read });
    await yieldTick();
    if (sessions.length >= max) break;
  }
  const nextStart = timedOut && dirs.length > 0 ? (start + visited) % dirs.length : undefined;
  return {
    sessions,
    truncated: listing.truncated,
    timedOut,
    ...(nextStart === undefined ? {} : { nextStart }),
    fenced: false,
  };
}

/** One session's fresh read (observation clock + targeted rescans + unknown re-verification). */
export async function scanSessionOne(
  root: StoreRoot,
  sessionId: string,
  opts: ScanOpts = {},
): Promise<SessionStateRead> {
  const isCurrent = opts.isCurrent ?? (() => true);
  const read = readSessionStateById(root, sessionId);
  await yieldTick();
  if (!isCurrent()) return { kind: "absent" };
  return read;
}
