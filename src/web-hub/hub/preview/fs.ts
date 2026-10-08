/**
 * web-hub content-preview — the raw fs layer (web-hub-preview plan v3 §4.3/§4.5, PV2a).
 *
 * This is the ONLY preview module allowed to import `node:fs*` (source-scan pinned in
 * `tests/web-hub/hub/preview/source-scan.test.ts`, mirroring `hub/upload-fs.ts`'s boundary):
 * `admit.ts` / `stream.ts` / `verify.ts` / `sniff.ts` reach the disk exclusively through the
 * injectable `PreviewFs` surface (defined in `admit.ts` per plan §4.3 — this module only
 * type-imports it) so every fs call can be faked, slow-injected or errno-injected in tests.
 *
 * Beyond the real adapter this module owns the cross-cutting primitives both admission
 * classes share:
 * - `PREVIEW_READ_FLAGS` / `PREVIEW_TASK_OPEN_FLAGS` — the O_NOFOLLOW open flag sets;
 * - `mapFsError` — §4.3's fs error → HTTP response mapping table (cwd class AND upload class);
 * - `previewFsStep` / `racePreviewIo` — deadline/signal racing with unref'd timers ("所有 timer
 *   都 unref", §4.5.2): a step is only *initiated* while budget remains, and every hang surfaces
 *   as a `PreviewIoError` (`deadline`/`abort`) that `mapFsError` turns into 504/silent-abort.
 *
 * dir-plan v3.1 §2.4 (P1a) adds the zombie-fs circuit breaker `PreviewIoTracker` (the §0.1 C8
 * primitive: an abandoned-but-unsettled fs op — a hung NFS/autofs read — counts as a zombie;
 * once `zombies >= max` (default `PREVIEW_FS_ZOMBIE_MAX = 2`, leaving ≥2 libuv pool threads for
 * uploads/gzip/db) every further `previewFsStep` fast-fails `busy` (503 `E_BUSY`) BEFORE its
 * `lazy()` runs. `previewFsStep`'s tracker is a MANDATORY option — forgetting it is a compile
 * error, and the never-break escape hatch `NO_TRACKER` is reference-restricted (source-scan)
 * to this file and tests/. `racePreviewIo`'s tracker stays optional so the pre-tracker callers
 * (verify.ts ×5, stream.ts ×1 — both run only AFTER admission proved the file responsive, with
 * their own deadlines) keep byte-identical behavior.
 *
 * §2.6 adds `resolvePreviewDenyContext` — the startup-time literal+canonical resolution of
 * home/agentDir for the admitter's deny context (each realpath is itself a tracked step; a
 * failure degrades that member to literal-only with a path-free WARN, never throws).
 */

import { constants as fsConstants, existsSync } from "node:fs";
import { open, readlink, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { HubLog } from "../ports.js";
import type { ReqDeadline } from "../req-deadline.js";
import { createReqDeadline } from "../req-deadline.js";
import type { PreviewDenyContext, PreviewFs, PreviewHandle, PreviewStat } from "./admit.js";

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

/** §2.4 total budget of the startup deny-context resolution (its own ReqDeadline, not a
 * request's — the two realpaths each race the full 2s against this one budget). */
export const PREVIEW_DENY_CTX_MS = 2_000;

// ---------------------------------------------------------------------------
// §2.4 PreviewIoTracker — the zombie-fs circuit breaker
// ---------------------------------------------------------------------------

/** dir-plan §0.1 C8/§2.4: once this many raced-out-but-unsettled fs ops exist, every further
 * preview fs step fast-fails `busy`. 2 keeps at least half of libuv's default 4-thread pool
 * available to uploads/gzip/db handshakes. */
export const PREVIEW_FS_ZOMBIE_MAX = 2;

export interface PreviewIoTracker {
  /** Abandoned (raced-out/aborted) underlying promises that have not settled yet. */
  readonly zombies: number;
  /** Trip threshold — `previewFsStep` fast-fails when `zombies >= max`. */
  readonly max: number;
}

/** The counting state lives in a module-private WeakMap so the frozen public interface stays
 * exactly `zombies`/`max` and only `racePreviewIo` can move the counter (JS single-threaded ⇒
 * the +=/-= transitions are atomic; only the abandoned→settled edge ever decrements, so the
 * count can never go negative). */
interface TrackerState {
  zombies: number;
}

const trackerStates = new WeakMap<PreviewIoTracker, TrackerState>();

export function createPreviewIoTracker(max: number = PREVIEW_FS_ZOMBIE_MAX): PreviewIoTracker {
  const state: TrackerState = { zombies: 0 };
  const tracker: PreviewIoTracker = {
    get zombies(): number {
      return state.zombies;
    },
    get max(): number {
      return max;
    },
  };
  trackerStates.set(tracker, state);
  return tracker;
}

/** §2.4 sentinel: `max = Infinity`, never trips. Its reference range is pinned by the
 * source-scan guard to THIS file and `tests/` — production code cannot silently opt out. */
export const NO_TRACKER: PreviewIoTracker = createPreviewIoTracker(Infinity);

// ---------------------------------------------------------------------------
// deadline / abort racing (§4.5.2 "所有 timer 都 unref")
// ---------------------------------------------------------------------------

/** The ways a raced fs call can fail without an errno: budget exhausted / caller aborted /
 * the §2.4 tracker circuit-breaker (never reaches an errno — `lazy` was not even called). */
export type PreviewIoFail = "deadline" | "abort" | "busy";

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
 *
 * §2.4 state machine (per raced promise, closure-local): `running → settled` (the underlying
 * settled before the race gave up — NOT counted) / `running → abandoned` (deadline/abort won;
 * the `done` flag makes this edge fire at most once ⇒ `zombies += 1`) / `abandoned → settled`
 * (the underlying's then/catch lands — `zombies -= 1`). Only `racePreviewIo` moves the state,
 * so a shared tracker can never double-count. `tracker` is OPTIONAL and deliberately so:
 * `verify.ts`/`stream.ts` keep their pre-tracker semantics (not counted, never tripped).
 */
export function racePreviewIo<T>(
  p: Promise<T>,
  deadlineAt: number,
  signal: AbortSignal | undefined,
  now: () => number,
  tracker?: PreviewIoTracker,
): Promise<T> {
  const state = tracker === undefined ? undefined : trackerStates.get(tracker);
  let counted = false; // running→abandoned fired for THIS race (only its own settle may decrement)
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
    const rejectWith = (fail: PreviewIoFail): void => {
      // the RACE side is giving up — this is the (at-most-once) running→abandoned edge
      if (state !== undefined && !counted) {
        counted = true;
        state.zombies += 1;
      }
      finish(() => reject(new PreviewIoError(fail, "preview io raced out")));
    };
    const settleUnderlying = (deliver: () => void): void => {
      // the UNDERLYING side settling — the abandoned→settled edge decrements exactly once
      if (counted) {
        counted = false;
        if (state !== undefined) state.zombies -= 1;
      }
      deliver();
    };
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
      (v) => settleUnderlying(() => finish(() => resolve(v))),
      (err: unknown) => settleUnderlying(() => finish(() => reject(err))),
    );
  });
}

/** §2.4: `previewFsStep`'s options — `tracker` is MANDATORY (a production call site cannot
 * compile without one; the never-break escape is the source-scan-restricted `NO_TRACKER`). */
export interface PreviewFsStepOpts {
  /** default `PREVIEW_FS_STEP_MS`; exposed for fast tests only. */
  stepCapMs?: number;
  now(): number;
  /** checked BEFORE `lazy()` runs: `zombies >= max` ⇒ `PreviewIoError("busy")` — the call is
   * never initiated, so it is not counted either. */
  tracker: PreviewIoTracker;
}

/**
 * §3.1 ⑦c/⑧ budget shape: the call is created lazily — `lazy()` is NOT invoked when the budget
 * is already exhausted or the signal already aborted — and raced against
 * `min(stepCapMs, deadline.remaining())` with an unref'd timer. PV3's routes reuse this for the
 * two read steps that stay inside the admission budget (the 64 KiB sniff sample and the JPEG
 * continuation read, "8 个 fs 步骤" #7/#8). §2.4: every step passes its owner's tracker, so a
 * raced-out call counts as a zombie until its underlying promise settles, and a tracker at its
 * threshold fast-fails `busy` (mapped 503 `E_BUSY` by `mapFsError`) before any new fs work.
 */
export function previewFsStep<T>(
  lazy: () => Promise<T>,
  deadline: { remaining(): number },
  signal: AbortSignal | undefined,
  opts: PreviewFsStepOpts,
): Promise<T> {
  const now = opts.now;
  const tracker = opts.tracker;
  if (tracker.zombies >= tracker.max) {
    return Promise.reject(new PreviewIoError("busy", "preview io tracker tripped"));
  }
  if (signal?.aborted) {
    return Promise.reject(new PreviewIoError("abort", "signal aborted before fs step"));
  }
  const remaining = deadline.remaining();
  if (remaining <= 0) {
    return Promise.reject(new PreviewIoError("deadline", "budget exhausted before fs step"));
  }
  const budget = Math.min(opts.stepCapMs ?? PREVIEW_FS_STEP_MS, remaining);
  return racePreviewIo(Promise.resolve().then(lazy), now() + budget, signal, now, tracker);
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
  if (fail === "busy") return { kind: "response", body: { status: 503, code: "E_BUSY", retryAfterS: 1 } };
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
// §2.6 startup deny-context resolution (home / agentDir literal + canonical)
// ---------------------------------------------------------------------------

/** dir-plan §2.6: `config.home` / `PI_CODING_AGENT_DIR` may themselves be symlinks — under
 * global admission (U4) the literal `${home}/…` deny rules would miss every canonical-path
 * request, so each base is resolved ONCE at hub start. */
export interface ResolvePreviewDenyContextDeps {
  /** a STARTUP-private tracker (never the request instance — §2.4's parameter-flow table). */
  tracker: PreviewIoTracker;
  now(): number;
  log: HubLog;
  /** the `startHub` startup signal; an aborted resolution degrades, never throws. */
  signal?: AbortSignal | undefined;
  fs?: Partial<PreviewFs> | undefined;
  /** default `PREVIEW_DENY_CTX_MS`; tests only. */
  stepCapMs?: number | undefined;
}

function trimTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function dedupeBases(literal: string, canonical: string | undefined): string[] {
  const out: string[] = [];
  for (const b of [literal, canonical]) {
    if (b === undefined) continue;
    const n = trimTrailingSlash(b);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Resolve one base: `realpath` through a tracked 2s step; ANY failure (errno, deadline,
 * abort) degrades to the literal-only form with a path-free WARN (§2.6 — the global twin
 * rules of §2.3 keep the pipeline from widening; the admission itself is unchanged). */
async function resolveBase(
  which: "home" | "agentDir",
  base: string,
  deps: ResolvePreviewDenyContextDeps,
  deadline: ReqDeadline,
): Promise<string[]> {
  const fs: PreviewFs = { ...defaultPreviewFs(), ...deps.fs };
  try {
    const canonical = await previewFsStep(() => fs.realpath(base), deadline, deps.signal, {
      ...(deps.stepCapMs === undefined ? {} : { stepCapMs: deps.stepCapMs }),
      now: deps.now,
      tracker: deps.tracker,
    });
    return dedupeBases(base, typeof canonical === "string" ? canonical : undefined);
  } catch {
    deps.log.warn("preview deny context: realpath failed", {
      event: "preview.deny_ctx_degraded",
      which, // no path — same §4.5 discipline as the audit lines
    });
    return dedupeBases(base, undefined);
  }
}

/** §2.6: `{ homes, agentDirs }`, each the literal + canonical deduped list. NEVER rejects —
 * a failing realpath degrades that member to literal-only (see `resolveBase`). */
export async function resolvePreviewDenyContext(
  bases: { home: string; agentDir: string },
  deps: ResolvePreviewDenyContextDeps,
): Promise<PreviewDenyContext> {
  const deadline = createReqDeadline(deps.now, PREVIEW_DENY_CTX_MS);
  const homes = await resolveBase("home", bases.home, deps, deadline);
  const agentDirs = await resolveBase("agentDir", bases.agentDir, deps, deadline);
  return { homes, agentDirs };
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
    procFdAvailable: () => previewProcFdAvailable(),
  };
}

/** §3.1/§3.6 (P1b's cap gate, exported here since fs.ts owns the disk): synchronous `/proc/
 * self/fd` availability — `false` ⇒ directory listings stay fail-closed (415) and the hub
 * never declares `preview.dir.v1`. */
export function previewProcFdAvailable(): boolean {
  return process.platform === "linux" && existsSync("/proc/self/fd");
}
