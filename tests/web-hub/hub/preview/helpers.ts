/**
 * Shared fakes for the PV2a preview-kernel tests (`tests/web-hub/hub/preview/`).
 *
 * Two strategies, deliberately split:
 * - admission/TOCTOU tests want REAL kernel semantics, so `hookedFs()` wraps the real
 *   `defaultPreviewFs()` with counters, delays, injected errors and post-call mutations —
 *   syscalls stay real, only their timing/failure is scripted;
 * - stream/verify tests want full determinism, so `FakeHandle`/`fakeTaskFs()`/`FakeSink` are
 *   pure in-memory fakes implementing exactly the `PreviewFs`/`PreviewHandle`/`PreviewSink`
 *   structural slices.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreviewFs, PreviewHandle, PreviewStat } from "../../../../src/web-hub/hub/preview/admit.js";
import { defaultPreviewFs } from "../../../../src/web-hub/hub/preview/fs.js";
import type { PreviewSink } from "../../../../src/web-hub/hub/preview/stream.js";
import { memLog, tmpDirs } from "../helpers.js";
import type { MemLog } from "../helpers.js";
import { createReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";
import type { ReqDeadline } from "../../../../src/web-hub/hub/req-deadline.js";

export { memLog, tmpDirs };
export type { MemLog };

export function deadline(totalMs: number, now: () => number = Date.now): ReqDeadline {
  return createReqDeadline(now, totalMs);
}

export function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

/** Ctrl that aborts with `reason` after `ms` (unref'd timer), for client/hub-close simulation. */
export function abortAfter(
  ms: number,
  reason: string,
  now: () => number = Date.now,
): { signal: AbortSignal; cancel(): void } {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(reason), ms);
  t.unref();
  return { signal: ctl.signal, cancel: () => clearTimeout(t) };
}

// ---------------------------------------------------------------------------
// real-fs wrapper with hooks
// ---------------------------------------------------------------------------

export type FsMethodName = "realpath" | "stat" | "open" | "readlink" | "procFdAvailable";

export interface FsHooks {
  /** resolve the underlying call this many ms late (never later than the caller's step cap). */
  delayMs?: Partial<Record<FsMethodName, number>>;
  /** reject the Nth call of a method with this error (counts per method). */
  failOn?: Partial<Record<FsMethodName, { call: number; err: Error }>>;
  /** replace the resolved value of a call (fake readlink results, fake procFdAvailable…). */
  override?: Partial<Record<FsMethodName, unknown>>;
  /** run right after the underlying call resolves — the TOCTOU mutation window. */
  after?: Partial<Record<FsMethodName, (p: string) => void>>;
  readonly counts: Record<string, number>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.());

export function hookedFs(hooks: FsHooks = { counts: {} }): PreviewFs & { counts: Record<string, number> } {
  const real = defaultPreviewFs();
  const counts = hooks.counts;
  const count = (m: string): void => {
    counts[m] = (counts[m] ?? 0) + 1;
  };
  const apply = async <T>(m: FsMethodName, p: string, underlying: () => Promise<T>): Promise<T> => {
    count(m);
    const fail = hooks.failOn?.[m];
    if (fail !== undefined && (counts[m] ?? 0) === fail.call) throw fail.err;
    const delay = hooks.delayMs?.[m];
    if (delay !== undefined) await sleep(delay);
    const v = await underlying();
    hooks.after?.[m]?.(p);
    const override = hooks.override?.[m];
    return (override === undefined ? v : (override as T)) as T;
  };
  return {
    counts,
    realpath: (p) => apply("realpath", p, () => real.realpath(p)),
    stat: (p) => apply("stat", p, () => real.stat(p)),
    open: (p, flags) => apply("open", p, () => real.open(p, flags)),
    readlink: (p) => apply("readlink", p, () => real.readlink(p)),
    procFdAvailable: () => {
      count("procFdAvailable");
      const override = hooks.override?.procFdAvailable;
      return typeof override === "boolean" ? override : real.procFdAvailable();
    },
  };
}

/** A scratch cwd: `{ root, file(path, content) }`, cleaned up by the caller. */
export function scratchCwd(prefix = "wh-pv2a-"): {
  root: string;
  file(rel: string, content: string | Buffer): string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    file(rel, content) {
      const p = join(root, rel);
      writeFileSync(p, content);
      return p;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function symlinkInto(dir: string, rel: string, target: string): string {
  const p = join(dir, rel);
  symlinkSync(target, p);
  return p;
}

// ---------------------------------------------------------------------------
// in-memory handle / fs / sink
// ---------------------------------------------------------------------------

export function fakeStat(over: Partial<PreviewStat> = {}): PreviewStat {
  const isFile = over.isFile ?? (() => true);
  return {
    dev: over.dev ?? 11,
    ino: over.ino ?? 22,
    size: over.size ?? 0,
    ctimeMs: over.ctimeMs ?? 1000,
    nlink: over.nlink ?? 1,
    isFile,
  };
}

export class FakeHandle implements PreviewHandle {
  /** mutable so tests can swap content/identity mid-flight (grow/shrink/replace) */
  content: Buffer;
  stat_: PreviewStat;
  readCalls = 0;
  closeCount = 0;
  private static nextFd = 100;

  constructor(content: Buffer, stat?: Partial<PreviewStat>) {
    this.content = content;
    this.stat_ = fakeStat({ ...(stat ?? {}), size: stat?.size ?? content.length });
  }

  get fd(): number {
    return this.stat_.ino; // stable unique-ish fd for /proc/self/fd fake routing
  }

  stat(): Promise<PreviewStat> {
    return Promise.resolve({ ...this.stat_, isFile: () => this.stat_.isFile() });
  }

  read(buf: Buffer, off: number, len: number, pos: number): Promise<{ bytesRead: number }> {
    this.readCalls += 1;
    const avail = Math.max(0, this.content.length - pos);
    const n = Math.min(len, avail);
    if (n > 0) this.content.copy(buf, off, pos, pos + n);
    return Promise.resolve({ bytesRead: n });
  }

  close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }
}

/**
 * The minimal fs the verify single-flight needs: `open("/proc/self/fd/<n>")` hands out a NEW
 * `FakeHandle` over the same (current) content — modelling the independent fd the real kernel
 * produces. Everything else throws (must never be reached).
 */
export function fakeTaskFs(byFd: Map<number, () => PreviewHandle>): PreviewFs & { opens: string[] } {
  const opens: string[] = [];
  return {
    opens,
    realpath: () => Promise.reject(new Error("not implemented")),
    stat: () => Promise.reject(new Error("not implemented")),
    open: (p) => {
      opens.push(p);
      const m = /^\/proc\/self\/fd\/(\d+)$/.exec(p);
      const make = m !== null ? byFd.get(Number(m[1])) : undefined;
      if (make === undefined) {
        const err = new Error(`no such fd: ${p}`) as Error & { code: string };
        err.code = "ENOENT";
        return Promise.reject(err);
      }
      return Promise.resolve(make());
    },
    readlink: () => Promise.reject(new Error("not implemented")),
    procFdAvailable: () => true,
  };
}

export interface SinkDrainPlan {
  /** never resolve waitDrain (slow client) */
  hang?: boolean;
}

export class FakeSink implements PreviewSink {
  readonly chunks: Buffer[] = [];
  head: { status: number; headers: Record<string, string> } | undefined;
  ended = false;
  destroyed = false;
  drainWaiters = 0;
  private plan: SinkDrainPlan;
  /** set to `false` to force `write` to report backpressure */
  backpressure = true;

  constructor(plan: SinkDrainPlan = {}) {
    this.plan = plan;
  }

  get headersSent(): boolean {
    return this.head !== undefined;
  }

  get bytes(): number {
    return this.chunks.reduce((n, c) => n + c.length, 0);
  }

  body(): Buffer {
    return Buffer.concat(this.chunks);
  }

  writeHead(status: number, headers: Record<string, string>): void {
    if (this.head !== undefined) throw new Error("writeHead called twice");
    this.head = { status, headers };
  }

  write(chunk: Buffer): boolean {
    if (this.head === undefined) throw new Error("write before writeHead");
    this.chunks.push(chunk);
    return this.backpressure;
  }

  waitDrain(_signal: AbortSignal): Promise<void> {
    if (this.plan.hang) {
      this.drainWaiters += 1;
      return new Promise(() => undefined);
    }
    return Promise.resolve();
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}
