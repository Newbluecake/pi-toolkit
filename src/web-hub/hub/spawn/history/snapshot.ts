/**
 * web-hub session-history plan §4.5.7 (`snapshot.ts`): fork snapshots (PD12) — the hub never
 * hands pi the live session file; it copies complete lines read through the ALREADY-PINNED fd
 * (re-opened via its own `/proc/self/fd/<fd>` magic link — a fresh, independent file
 * description on the same inode, never a by-path walk) into a hub-owned 0700 directory, then
 * `pi --fork <snapshot>`.
 */
import { randomBytes } from "node:crypto";
import type { ReqDeadline } from "../../req-deadline.js";
import type { ForkSnapshot, SessionPin, SnapshotResult } from "./ports.js";
import { getPinnedFileFd } from "./pin.js";
import {
  errCodeOf,
  fdPath,
  HISTORY_FILE_CREATE_FLAGS,
  HISTORY_TASK_OPEN_FLAGS,
  type HistoryFs,
  type HistoryHandle,
} from "./fs.js";
import { boundedClose, boundedFdOpen, boundedUnlink, historyStep, type HistoryIoGate } from "./budget.js";
import {
  FORK_SRC_SWEEP_STEP_MS,
  HISTORY_SNAPSHOT_BLOCK_BYTES,
  HISTORY_SNAPSHOT_BUDGET_MS,
  HISTORY_SNAPSHOT_MAX_BYTES,
} from "./budget.js";
import type { FdLedger } from "./fd-ledger.js";

export interface SnapshotDeps {
  forkSrcDir: string;
  fs: HistoryFs;
  gate: HistoryIoGate;
  ledger: FdLedger;
  now(): number;
}

/** Lazily created + verified (uid/mode 0700/not-a-symlink) exactly once per service instance —
 * "首次使用时" (§4.5.7). A later swap of the directory is outside this plan's threat model
 * (same trust boundary as the sessionsRoot realpath, which is likewise cached). */
export interface ForkSrcDirState {
  verified: boolean;
}

export function createForkSrcDirState(): ForkSrcDirState {
  return { verified: false };
}

/** Verifier round 3 (defect 3b): per-step bound shared by `ensureForkSrcDir` and the startup
 * sweep — same discipline as `sweepForkSrcDir`'s original local `bounded`: its OWN deadline
 * (`FORK_SRC_SWEEP_STEP_MS`, never the request's), unref'd timer, timeout surfaces as a plain
 * rejection the caller maps to its existing fail-closed path. */
function raceStep<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("fork-src-step-timeout")), FORK_SRC_SWEEP_STEP_MS);
    t.unref();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

async function ensureForkSrcDir(dir: string, fs: HistoryFs): Promise<boolean> {
  try {
    const st = await raceStep(fs.lstat(dir));
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if ((st.mode & 0o777) !== 0o700) return false;
    return true;
  } catch (err) {
    if (errCodeOf(err) !== "ENOENT") return false;
  }
  try {
    await raceStep(fs.mkdir(dir, 0o700));
  } catch {
    return false;
  }
  try {
    const st = await raceStep(fs.lstat(dir));
    return !st.isSymbolicLink() && st.isDirectory() && (st.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

function randomSnapName(): string {
  return `snap-${randomBytes(12).toString("base64url")}.jsonl`;
}

export async function snapshotFork(
  pin: SessionPin,
  deadline: ReqDeadline,
  deps: SnapshotDeps,
  dirState: ForkSrcDirState,
): Promise<SnapshotResult> {
  const budgetMs = Math.min(HISTORY_SNAPSHOT_BUDGET_MS, Math.max(0, deadline.remaining() - 3000));
  if (budgetMs <= 0) return { ok: false, status: 504 };
  const deadlineAt = deps.now() + budgetMs;
  const step = <T>(lazy: () => Promise<T>): Promise<T> => historyStep(deps.gate, lazy, deadlineAt, deps.now);
  const closeDeps = { gate: deps.gate, now: deps.now };
  const openDeps = { gate: deps.gate, ledger: deps.ledger, now: deps.now };

  if (!dirState.verified) {
    const ok = await ensureForkSrcDir(deps.forkSrcDir, deps.fs);
    if (!ok) return { ok: false, status: 504 }; // frozen SnapshotResult has no 503 slot (see report)
    dirState.verified = true;
  }

  if (pin.size > HISTORY_SNAPSHOT_MAX_BYTES) return { ok: false, status: 400, reason: "session-too-large" };

  const srcFd = getPinnedFileFd(pin);
  if (srcFd === undefined) return { ok: false, status: 504 };

  const name = randomSnapName();
  const path = `${deps.forkSrcDir}/${name}`;
  let srcH: HistoryHandle | undefined;
  let dstH: HistoryHandle | undefined;
  const cleanupAndFail = async (result: SnapshotResult): Promise<SnapshotResult> => {
    if (dstH !== undefined) {
      await boundedClose(() => dstH!.close(), closeDeps);
      deps.ledger.release(1, "temp");
    }
    if (srcH !== undefined) {
      await boundedClose(() => srcH!.close(), closeDeps);
      deps.ledger.release(1, "temp");
    }
    await boundedUnlink(() => deps.fs.unlink(path), closeDeps);
    return result;
  };

  const srcRes = await boundedFdOpen(
    1,
    "temp",
    () => deps.fs.open(fdPath(srcFd), HISTORY_TASK_OPEN_FLAGS),
    deadlineAt,
    openDeps,
  );
  if (!srcRes.ok) return { ok: false, status: 504 }; // busy/deadline/error — boundedFdOpen already released
  srcH = srcRes.handle;
  const dstRes = await boundedFdOpen(
    1,
    "temp",
    () => deps.fs.open(path, HISTORY_FILE_CREATE_FLAGS, 0o600),
    deadlineAt,
    openDeps,
  );
  if (!dstRes.ok) return cleanupAndFail({ ok: false, status: 504 });
  dstH = dstRes.handle;

  let lastNewline = -1; // last byte offset (exclusive) we've written through a trailing "\n"
  let written = 0;
  let position = 0;
  const limit = pin.size;
  try {
    while (position < limit) {
      if (deadline.expired() || deps.now() >= deadlineAt) return await cleanupAndFail({ ok: false, status: 504 });
      const blockLen = Math.min(HISTORY_SNAPSHOT_BLOCK_BYTES, limit - position);
      const buf = Buffer.alloc(blockLen);
      const { bytesRead } = await step(() => srcH!.read(buf, 0, blockLen, position));
      if (bytesRead <= 0) break;
      const chunk = bytesRead === blockLen ? buf : buf.subarray(0, bytesRead);
      await step(() => dstH!.write(chunk, 0, chunk.length, written));
      // track the furthest trailing "\n" seen across the whole stream so far
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] === 0x0a) {
          lastNewline = written + i + 1;
          break;
        }
      }
      written += chunk.length;
      position += bytesRead;
    }
  } catch {
    return cleanupAndFail({ ok: false, status: 504 });
  }

  const finalLen = lastNewline < 0 ? 0 : lastNewline;
  if (finalLen < written) {
    try {
      await step(() => dstH!.truncate(finalLen));
    } catch {
      return cleanupAndFail({ ok: false, status: 504 });
    }
  }

  let dstStat: Awaited<ReturnType<HistoryHandle["stat"]>>;
  try {
    dstStat = await step(() => dstH!.stat());
  } catch {
    return cleanupAndFail({ ok: false, status: 504 });
  }
  await boundedClose(() => dstH!.close(), closeDeps);
  deps.ledger.release(1, "temp");
  await boundedClose(() => srcH!.close(), closeDeps);
  deps.ledger.release(1, "temp");

  let discarded = false;
  const snapshot: ForkSnapshot = {
    path,
    dev: dstStat.dev,
    ino: dstStat.ino,
    size: finalLen,
    discard(): void {
      if (discarded) return;
      discarded = true;
      void boundedUnlink(() => deps.fs.unlink(path), closeDeps);
    },
  };
  return { ok: true, snapshot };
}

export interface VerifySnapshotDeps {
  fs: HistoryFs;
}

/** SYNC per the frozen port, but this module only has an async `HistoryFs` — service.ts wires
 * the sync `HistorySyncFs` for this specific check instead (see `service.ts`). Exported here as
 * the async reference implementation used by snapshot's own tests. */
export async function verifySnapshotAsync(s: ForkSnapshot, deps: VerifySnapshotDeps): Promise<boolean> {
  try {
    const st = await deps.fs.lstat(s.path);
    return !st.isSymbolicLink() && st.isFile() && st.dev === s.dev && st.ino === s.ino && (st.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

/** Startup sweep (§4.5.7): delete only regular files, never follow a symlink, bounded count.
 * Finding 5 fix: each lstat/unlink is now individually bounded (`FORK_SRC_SWEEP_STEP_MS`, its
 * OWN deadline, never the request's — there is no request here, this runs at startup) so one
 * hung entry can no longer stall the whole best-effort sweep indefinitely; failures are still
 * swallowed (best-effort, unchanged). */
export async function sweepForkSrcDir(dir: string, fs: HistoryFs, maxFiles: number): Promise<void> {
  const bounded = <T>(p: Promise<T>): Promise<T> => raceStep(p);
  let entries;
  try {
    entries = await bounded(fs.readdir(dir, { withFileTypes: true }));
  } catch {
    return;
  }
  let count = 0;
  for (const ent of entries) {
    if (count >= maxFiles) break;
    if (!ent.isFile()) continue;
    count += 1;
    const p = `${dir}/${ent.name}`;
    try {
      const st = await bounded(fs.lstat(p));
      if (st.isSymbolicLink() || !st.isFile()) continue;
      await bounded(fs.unlink(p));
    } catch {
      /* best effort */
    }
  }
}
