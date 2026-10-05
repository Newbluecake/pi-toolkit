/**
 * web-hub content-preview — upload-content re-verification (web-hub-preview plan v3 §4.5.3,
 * PV2a): the identity cache + single-flight whole-file sha256 the TEXT path consults BEFORE
 * its head is written (ruling #4/#5, D16). Images never come here — they hash while streaming
 * (`stream.ts`) and destroy on mismatch; this module is text-only by contract.
 *
 * Single-flight key is `${uploadId}|${dev}|${ino}|${size}|${ctimeMs}`: different identities of
 * the same upload NEVER merge. The task owns a fully INDEPENDENT fd — re-opened through
 * `/proc/self/fd/N` (a fresh open file description, so no waiter depends on the creating
 * request's handle staying open) — its own AbortController and a `verifyMs` budget. Waiters
 * each race the task against their own signal and their own `waitUntil`; when the last waiter
 * leaves, the task is aborted mid-read (no orphan O(n) work). All timers are unref'd
 * (`racePreviewIo`).
 */

import { createHash } from "node:crypto";
import type { HubLog } from "../ports.js";
import { isPreviewIoError, PREVIEW_TASK_OPEN_FLAGS, racePreviewIo } from "./fs.js";
import type { PreviewFs, PreviewHandle, PreviewStat } from "./admit.js";
import { defaultPreviewFs } from "./fs.js";
import { PREVIEW_VERIFY_MS } from "../../protocol/preview.js";

// ---------------------------------------------------------------------------
// §4.5 frozen interface
// ---------------------------------------------------------------------------

export interface Identity {
  dev: number;
  ino: number;
  size: number;
  ctimeMs: number;
}

export interface UploadVerifier {
  verifyWhole(
    p: { uploadId: string; sha256: string; fh: PreviewHandle; identity: Identity },
    opts: { signal: AbortSignal; waitUntil: number },
  ): Promise<"cached" | "hashed" | "joined" | { fail: "hash-mismatch" | "verify-timeout" | "verify-deadline" | "io" }>;
  remember(uploadId: string, identity: Identity): void;
  dispose(): void;
}

export function identityOf(st: PreviewStat): Identity {
  return { dev: st.dev, ino: st.ino, size: st.size, ctimeMs: st.ctimeMs };
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.ctimeMs === b.ctimeMs;
}

function taskKeyOf(uploadId: string, identity: Identity): string {
  return `${uploadId}|${identity.dev}|${identity.ino}|${identity.size}|${identity.ctimeMs}`;
}

// ---------------------------------------------------------------------------
// internal task
// ---------------------------------------------------------------------------

/** 64 KiB reused read buffer — the whole-file hash must never buffer the file (HP3). */
const VERIFY_CHUNK_BYTES = 64 * 1024;

/** FIFO cap for the identity cache — one entry per upload ever verified; plenty above the
 * upload store's live-record count, small enough to never matter. */
const IDENTITY_CACHE_MAX = 512;

type TaskOutcome = "ok" | { fail: "hash-mismatch" | "verify-timeout" | "abandoned" | "io" };

interface Task {
  readonly key: string;
  readonly ctl: AbortController;
  waiters: number;
  readonly promise: Promise<TaskOutcome>;
}

export interface UploadVerifierDeps {
  fs?: Partial<PreviewFs>;
  log: HubLog;
  now(): number;
  /** single-flight task budget; defaults to `PREVIEW_VERIFY_MS` (exposed for fast tests). */
  verifyMs?: number;
}

/**
 * The task's own fd: re-open `/proc/self/fd/<n>` (magic symlink ⇒ the kernel hands back a NEW
 * open file description — positioned reads never touch any waiter's offset, and the task
 * survives the creating request closing its handle). `O_NOFOLLOW` must stay OFF here. On a
 * platform without procfs the task degrades to reading through the caller's own handle
 * (`owns:false`, R3) — the digest still gates everything, so the degraded mode can only fail
 * closed.
 */
function openTaskFd(
  p: { fh: PreviewHandle },
  fs: PreviewFs,
  deadlineAt: number,
  signal: AbortSignal,
  now: () => number,
): Promise<{ fh: PreviewHandle; owns: boolean }> {
  return racePreviewIo(fs.open(`/proc/self/fd/${p.fh.fd}`, PREVIEW_TASK_OPEN_FLAGS), deadlineAt, signal, now).then(
    (fh) => ({ fh, owns: true }),
    (err: unknown) => {
      if (isPreviewIoError(err)) throw err; // deadline/abort keep their own semantics
      if (!fs.procFdAvailable()) return { fh: p.fh, owns: false };
      throw err; // procfs present but the re-open failed — a real io error
    },
  );
}

export function createUploadVerifier(deps: UploadVerifierDeps): UploadVerifier {
  const fs: PreviewFs = { ...defaultPreviewFs(), ...deps.fs };
  const verifyMs = deps.verifyMs ?? PREVIEW_VERIFY_MS;
  const cache = new Map<string, Identity>();
  const tasks = new Map<string, Task>();

  const cacheSet = (uploadId: string, identity: Identity): void => {
    if (cache.size >= IDENTITY_CACHE_MAX) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(uploadId, identity);
  };

  const dropTask = (task: Task): void => {
    if (tasks.get(task.key) === task) tasks.delete(task.key);
  };

  const createTask = (p: { uploadId: string; sha256: string; fh: PreviewHandle; identity: Identity }): Task => {
    const key = taskKeyOf(p.uploadId, p.identity);
    const ctl = new AbortController();
    const deadlineAt = deps.now() + verifyMs;
    const task: Task = {
      key,
      ctl,
      waiters: 0,
      promise: (async (): Promise<TaskOutcome> => {
        try {
          const opened = await openTaskFd(p, fs, deadlineAt, ctl.signal, deps.now);
          try {
            const hasher = createHash("sha256");
            const buf = Buffer.allocUnsafe(VERIFY_CHUNK_BYTES);
            let pos = 0;
            for (;;) {
              const { bytesRead } = await racePreviewIo(
                opened.fh.read(buf, 0, buf.length, pos),
                deadlineAt,
                ctl.signal,
                deps.now,
              );
              if (bytesRead === 0) break;
              hasher.update(buf.subarray(0, bytesRead));
              pos += bytesRead;
            }
            const st = await racePreviewIo(opened.fh.stat(), deadlineAt, ctl.signal, deps.now);
            const digest = hasher.digest("hex");
            if (digest !== p.sha256) {
              // logged HERE (task completion), not per waiter — N concurrent requests on one
              // mismatch produce exactly one log.error (PV2a acceptance)
              deps.log.error("preview verify hash-mismatch", { uploadId: p.uploadId });
              return { fail: "hash-mismatch" };
            }
            cacheSet(p.uploadId, identityOf(st));
            return "ok";
          } finally {
            if (opened.owns) {
              await opened.fh.close().then(
                () => undefined,
                () => undefined,
              );
            }
          }
        } catch (err) {
          if (ctl.signal.aborted) return { fail: "abandoned" };
          if (isPreviewIoError(err)) {
            return err.ioFail === "deadline" ? { fail: "verify-timeout" } : { fail: "abandoned" };
          }
          return { fail: "io" };
        }
      })().finally(() => dropTask(task)),
    };
    return task;
  };

  return {
    async verifyWhole(p, opts) {
      // -- identity-cache fast path (§4.5.2 text 3: only valid if post ALSO still matches) ----
      const cached = cache.get(p.uploadId);
      if (cached !== undefined && sameIdentity(cached, p.identity)) {
        try {
          const st = await racePreviewIo(p.fh.stat(), opts.waitUntil, opts.signal, deps.now);
          if (sameIdentity(identityOf(st), p.identity)) return "cached";
          // post changed → still before any head was written: fall through to single-flight
        } catch (err) {
          if (isPreviewIoError(err)) {
            if (err.ioFail === "abort") throw err;
            return { fail: "verify-deadline" };
          }
          return { fail: "io" };
        }
      }

      // -- single-flight (§4.5.3) --------------------------------------------------------------
      const key = taskKeyOf(p.uploadId, p.identity);
      let task = tasks.get(key);
      const creator = task === undefined;
      if (task === undefined) {
        task = createTask(p);
        tasks.set(key, task);
      }
      task.waiters += 1;
      try {
        const outcome = await racePreviewIo(task.promise, opts.waitUntil, opts.signal, deps.now);
        if (outcome === "ok") return creator ? "hashed" : "joined";
        // "abandoned" is unreachable for a waiter: the task is only aborted after the LAST
        // waiter left, and that waiter returned through its own abort race instead
        return outcome.fail === "abandoned" ? { fail: "io" } : { fail: outcome.fail };
      } catch (err) {
        if (isPreviewIoError(err)) {
          if (err.ioFail === "abort") throw err; // the waiter's own signal — caller classifies
          return { fail: "verify-deadline" }; // the waiter's own waitUntil hit first
        }
        return { fail: "io" };
      } finally {
        task.waiters -= 1;
        if (task.waiters <= 0) {
          dropTask(task);
          task.ctl.abort("no-waiters");
        }
      }
    },

    remember(uploadId, identity) {
      cacheSet(uploadId, identity);
    },

    dispose() {
      for (const task of tasks.values()) task.ctl.abort("dispose");
      tasks.clear();
      cache.clear();
    },
  };
}
