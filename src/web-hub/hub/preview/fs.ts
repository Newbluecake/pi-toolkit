/**
 * web-hub content-preview — the raw fs layer (web-hub-preview plan v3 §4.3/§4.5, PV2a).
 *
 * This is the ONLY preview module allowed to import `node:fs*` (source-scan pinned in
 * `tests/web-hub/hub/preview/source-scan.test.ts`, mirroring `hub/upload-fs.ts`'s boundary):
 * `admit.ts` / `stream.ts` / `verify.ts` / `sniff.ts` reach the disk exclusively through the
 * injectable `PreviewFs` surface (defined in `admit.ts` per plan §4.3 — this module only
 * type-imports it) so every fs call can be faked, slow-injected or errno-injected in tests.
 *
 * Beyond the real adapter this module owns the three cross-cutting primitives both admission
 * classes share:
 * - `PREVIEW_READ_FLAGS` / `PREVIEW_TASK_OPEN_FLAGS` — the O_NOFOLLOW open flag sets;
 * - `mapFsError` — §4.3's fs error → HTTP response mapping table (cwd class AND upload class);
 * - `previewFsStep` / `racePreviewIo` — deadline/signal racing with unref'd timers ("所有 timer
 *   都 unref", §4.5.2): a step is only *initiated* while budget remains, and every hang surfaces
 *   as a `PreviewIoError` (`deadline`/`abort`) that `mapFsError` turns into 504/silent-abort.
 */

import { constants as fsConstants, existsSync } from "node:fs";
import { open, readlink, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { PreviewFs, PreviewHandle, PreviewStat } from "./admit.js";

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

/**
 * §4.3 step 10: `O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY` — never through a final-segment
 * symlink (`O_NOFOLLOW`, `upload-fs.ts` `TRUSTED_READ_FLAGS`'s reasoning), never hanging on a
 * swapped-in FIFO/device (`O_NONBLOCK`), never stealing the controlling terminal (`O_NOCTTY`).
 */
export const PREVIEW_READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOCTTY ?? 0);

/**
 * §4.5.3: the single-flight hash task re-opens the file through its own fd — `/proc/self/fd/N`
 * is a *magic* symlink the kernel resolves to a fresh, fully independent open file description,
 * so `O_NOFOLLOW` must NOT be set here (it would ELOOP on the procfs symlink). Plain `O_RDONLY`
 * on our own process's fd table entry is attacker-free (the fd number comes from a handle this
 * process already holds open).
 */
export const PREVIEW_TASK_OPEN_FLAGS = fsConstants.O_RDONLY;

/** §4.3 预算: per-fs-step cap, `min(PREVIEW_FS_STEP_MS, remaining)` of the shared ReqDeadline. */
export const PREVIEW_FS_STEP_MS = 2_000;

// ---------------------------------------------------------------------------
// deadline / abort racing (§4.5.2 "所有 timer 都 unref")
// ---------------------------------------------------------------------------

/** The two ways a raced fs call can fail without an errno: budget exhausted / caller aborted. */
export type PreviewIoFail = "deadline" | "abort";

export class PreviewIoError extends Error {
  readonly ioFail: PreviewIoFail;

  constructor(ioFail: PreviewIoFail, message: string) {
    super(`preview-io: ${ioFail}: ${message}`);
    this.name = "PreviewIoError";
    this.ioFail = ioFail;
  }
}

export function isPreviewIoError(err: unknown): err is PreviewIoError {
  return err instanceof PreviewIoError;
}

function ioFailOf(err: unknown): PreviewIoFail | undefined {
  if (isPreviewIoError(err)) return err.ioFail;
  if (err instanceof Error && err.name === "AbortError") return "abort";
  return undefined;
}

/**
 * Race `p` against an absolute wall-clock deadline and (optionally) an AbortSignal. Every timer
 * created here is unref'd; the abort listener is removed as soon as anything settles, so a
 * long-lived request signal never accumulates listeners. A late underlying result simply
 * resolves a promise nobody awaits anymore — callers with fd-producing promises (admit's
 * `open`) attach their own late-close recovery (§4.3 "迟到的 open 会被回收").
 */
export function racePreviewIo<T>(
  p: Promise<T>,
  deadlineAt: number,
  signal: AbortSignal | undefined,
  now: () => number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    let done = false;
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const rejectWith = (fail: PreviewIoFail): void =>
      finish(() => reject(new PreviewIoError(fail, "preview io raced out")));
    timer = setTimeout(() => rejectWith("deadline"), Math.max(0, deadlineAt - now()));
    timer.unref();
    if (signal !== undefined) {
      if (signal.aborted) {
        rejectWith("abort");
        return;
      }
      onAbort = () => rejectWith("abort");
      signal.addEventListener("abort", onAbort, { once: true });
    }
    p.then(
      (v) => finish(() => resolve(v)),
      (err: unknown) => finish(() => reject(err)),
    );
  });
}

/**
 * §3.1 ⑦c/⑧ budget shape: the call is created lazily — `lazy()` is NOT invoked when the budget
 * is already exhausted or the signal already aborted — and raced against
 * `min(stepCapMs, deadline.remaining())` with an unref'd timer. PV3's routes reuse this for the
 * two read steps that stay inside the admission budget (the 64 KiB sniff sample and the JPEG
 * continuation read, "8 个 fs 步骤" #7/#8).
 */
export function previewFsStep<T>(
  lazy: () => Promise<T>,
  deadline: { remaining(): number },
  signal: AbortSignal | undefined,
  opts: { stepCapMs?: number; now(): number },
): Promise<T> {
  const now = opts.now;
  if (signal?.aborted) {
    return Promise.reject(new PreviewIoError("abort", "signal aborted before fs step"));
  }
  const remaining = deadline.remaining();
  if (remaining <= 0) {
    return Promise.reject(new PreviewIoError("deadline", "budget exhausted before fs step"));
  }
  const budget = Math.min(opts.stepCapMs ?? PREVIEW_FS_STEP_MS, remaining);
  return racePreviewIo(Promise.resolve().then(lazy), now() + budget, signal, now);
}

// ---------------------------------------------------------------------------
// §4.3 fs error mapping table (shared by the cwd and upload admission classes)
// ---------------------------------------------------------------------------

export interface FsErrorResponse {
  readonly status: number;
  readonly code: string;
  readonly reason?: string;
  readonly retryAfterS?: number;
}

/** `mapFsError`'s result: a mapped HTTP response, or `abort` — "不应答" / hub-close handling is
 * the caller's (routes, PV3) decision because only it knows why its controller aborted. */
export type FsErrorMap = { kind: "response"; body: FsErrorResponse } | { kind: "abort" };

function errCodeOf(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export function mapFsError(err: unknown): FsErrorMap {
  const fail = ioFailOf(err);
  if (fail === "deadline") return { kind: "response", body: { status: 504, code: "E_DEADLINE" } };
  if (fail === "abort") return { kind: "abort" };
  switch (errCodeOf(err)) {
    case "ENOENT":
    case "ENOTDIR":
      return { kind: "response", body: { status: 404, code: "E_NOT_FOUND" } };
    case "EACCES":
    case "EPERM":
      return { kind: "response", body: { status: 403, code: "E_PREVIEW_DENIED", reason: "unreadable" } };
    case "ELOOP":
      return { kind: "response", body: { status: 409, code: "E_PREVIEW_CHANGED" } };
    case "EISDIR":
      return { kind: "response", body: { status: 415, code: "E_PREVIEW_UNSUPPORTED", reason: "not-regular" } };
    case "EMFILE":
    case "ENFILE":
    case "EAGAIN":
      return { kind: "response", body: { status: 503, code: "E_BUSY", retryAfterS: 1 } };
    default:
      return { kind: "response", body: { status: 500, code: "E_INTERNAL" } };
  }
}

// ---------------------------------------------------------------------------
// the real adapter
// ---------------------------------------------------------------------------

function toPreviewStat(st: {
  dev: number;
  ino: number;
  size: number;
  ctimeMs: number;
  nlink: number;
  isFile(): boolean;
}): PreviewStat {
  const isFile = st.isFile();
  return { dev: st.dev, ino: st.ino, size: st.size, ctimeMs: st.ctimeMs, nlink: st.nlink, isFile: () => isFile };
}

/** Real-`FileHandle` adapter: `close()` is idempotent so the stream layer's finally-close and a
 * defensive caller close can never double-close into an EBADF. */
class RealPreviewHandle implements PreviewHandle {
  private closed = false;

  constructor(private readonly h: FileHandle) {}

  get fd(): number {
    return this.h.fd;
  }

  stat(): Promise<PreviewStat> {
    return this.h.stat().then(toPreviewStat);
  }

  read(buf: Buffer, off: number, len: number, pos: number): Promise<{ bytesRead: number }> {
    return this.h.read(buf, off, len, pos);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return this.h.close();
  }
}

/** The production `PreviewFs`: `node:fs/promises` behind the injectable surface. */
export function defaultPreviewFs(): PreviewFs {
  return {
    realpath: (p) => realpath(p),
    stat: (p) => stat(p).then(toPreviewStat),
    open: (p, flags) => open(p, flags).then((h) => new RealPreviewHandle(h)),
    readlink: (p) => readlink(p),
    procFdAvailable: () => process.platform === "linux" && existsSync("/proc/self/fd"),
  };
}
