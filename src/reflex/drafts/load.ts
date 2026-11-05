/**
 * jev-reflex · #25 runtime draft loader (BA §4.6 rules 1–5, R-I13): bounded, no-follow, fail-closed,
 * one-shot. B0 froze the seams (`DraftFs`, `DRAFT_READ_FLAGS`, the `loadDrafts` signature); B4 fills
 * the body. Everything goes through the injectable `DraftFs`, so races are testable deterministically.
 *
 * Flow: trusted dir check (`<agentDir>/reflex` and `drafts`: real dir, ours, no group/other bits) →
 * streaming `opendir` (≤ DIR_SCAN_CAP dirents; the 65th ⇒ whole-dir `dir-cap`) → name whitelist, sorted,
 * first DRAFT_FILE_READ_CAP read → per file: no-follow `open`, SAME-fd `stat`, read ≤ cap+1 → `validateDraft`
 * → dev/ino recheck of the drafts dir (`dir-changed`) → everything under ONE `clampSpanMs(500)` budget
 * (timer via the injected Clock, unref'd by the production clock) that also honours `signal`.
 * It never throws and never rejects: any internal surprise degrades to a whole-directory failure.
 *
 * A MISSING `<agentDir>/reflex` or `drafts` directory (ENOENT) is the normal "feature on, nothing generated
 * yet" state: an empty result with no failure (nothing to trust, nothing loaded).
 *
 * `src/reflex/drafts/**` is inside the pi-free value closure (R-I10 extension, #25): no pi imports.
 */

import { constants as FS_CONSTANTS } from "node:fs";
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import { clampSpanMs } from "../../core/deadline.js";
import type { Clock, TimerHandle } from "../../core/clock.js";
import {
  DIR_SCAN_CAP,
  DRAFT_FILE_READ_CAP,
  DRAFT_LOAD_BUDGET_MS,
  DRAFT_MAX_FILE_BYTES,
  DRAFT_NAME_RE,
  validateDraft,
} from "../core/draft-schema.js";
import { draftHash, templateHash } from "../core/identity.js";
import type { DraftFileRejection, DraftLoadResult, DraftRejectCode, LoadedDraft, RScriptV1 } from "../core/types.js";

/** Open discipline for draft files: `O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY` — the same
 *  combination as `session-nav/session-head.ts` `SESSION_READ_FLAGS` (mirrored on purpose: the
 *  boundary gate forbids importing it; `tests/reflex/core` asserts the two constants are equal). */
export const DRAFT_READ_FLAGS: number =
  FS_CONSTANTS.O_RDONLY |
  (FS_CONSTANTS.O_NOFOLLOW ?? 0) |
  (FS_CONSTANTS.O_NONBLOCK ?? 0) |
  (FS_CONSTANTS.O_NOCTTY ?? 0);

/** The structural slice of `node:fs/promises` the loader uses — injectable for tests (BA §4.6). */
export interface DraftStatLike {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  gid: number;
  mode: number;
  size: number;
  dev: number;
  ino: number;
}

export interface DraftFileHandleLike {
  /** Same-fd stat: the descriptor was opened O_NOFOLLOW, so this stat cannot chase a swapped symlink. */
  stat(): Promise<DraftStatLike>;
  /** Bounded read (≤ DRAFT_MAX_FILE_BYTES + 1). */
  read(buffer: Buffer, position: number | null, length: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface DraftDirLike {
  close(): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<{ name: string }>;
}

export interface DraftFs {
  lstat(path: string): Promise<DraftStatLike>;
  opendir(path: string): Promise<DraftDirLike>;
  open(path: string, flags: number): Promise<DraftFileHandleLike>;
}

/** Production `DraftFs`: `node:fs/promises` with the file-handle `read` adapted to the (buffer, position, length) shape. */
export const defaultDraftFs: DraftFs = {
  lstat: (path) => fsp.lstat(path),
  opendir: (path) => fsp.opendir(path),
  open: async (path, flags) => {
    const h = await fsp.open(path, flags);
    return {
      stat: () => h.stat(),
      read: (buffer, position, length) => h.read(buffer, 0, length, position),
      close: () => h.close(),
    };
  },
};

type Stop = { stop: "timeout" | "aborted" };
const STOP_KEY = Symbol("draft-load-stop");

class Stopped extends Error {
  readonly [STOP_KEY] = true;
  constructor(readonly why: Stop["stop"]) {
    super(why);
  }
}

/** Printable, bounded rendering of an untrusted file name (it is shown in `/reflex drafts`). */
function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 64);
}

const errnoOf = (err: unknown): string | undefined =>
  err !== null && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : undefined;

const getuid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/**
 * Load the drafts directory (BA §4.6 rules 1–5). `dir` is the drafts directory; its parent is the
 * `reflex` directory. Never throws, never rejects; one-shot (no hot reload).
 */
export async function loadDrafts(
  dir: string,
  builtinIds: ReadonlySet<string>,
  clock: Clock,
  signal: AbortSignal,
  fs: DraftFs = defaultDraftFs,
): Promise<DraftLoadResult> {
  const fail = (code: DraftRejectCode, detail?: string): DraftLoadResult => ({
    loaded: [],
    rejected: [],
    failure: { code, ...(detail !== undefined ? { detail } : {}) },
  });
  if (signal.aborted) return fail("aborted");

  // ---- budget + abort: one `stopped` promise every await races against ----
  let stopWhy: Stop["stop"] | undefined;
  let wake: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const trip = (why: Stop["stop"]): void => {
    if (stopWhy === undefined) stopWhy = why;
    wake?.();
  };
  let timer: TimerHandle | undefined;
  const span = clampSpanMs(DRAFT_LOAD_BUDGET_MS);
  const onAbort = (): void => trip("aborted");
  try {
    if (span !== undefined) timer = clock.setTimer(span, () => trip("timeout"));
  } catch {
    /* a broken clock must not break the load; the abort signal still applies */
  }
  signal.addEventListener("abort", onAbort, { once: true });

  /** Race `p` against the stop signal. If stop wins, `late` runs on the eventual value (to close it). */
  const guarded = async <T>(p: Promise<T>, late?: (v: T) => void): Promise<T> => {
    if (stopWhy !== undefined) {
      p.then((v) => late?.(v)).catch(() => undefined);
      throw new Stopped(stopWhy);
    }
    const winner = await Promise.race([p.then((v) => ({ v })), stopped.then(() => undefined)]);
    if (winner === undefined) {
      p.then((v) => late?.(v)).catch(() => undefined);
      throw new Stopped(stopWhy ?? "aborted");
    }
    return winner.v;
  };

  const loaded: LoadedDraft[] = [];
  const rejected: DraftFileRejection[] = [];

  const readOne = async (
    fileName: string,
  ): Promise<{ id: string; draft: LoadedDraft } | { code: DraftRejectCode; detail?: string }> => {
    let h: DraftFileHandleLike | undefined;
    let stoppedMidway = false;
    try {
      try {
        h = await guarded(
          fs.open(join(dir, fileName), DRAFT_READ_FLAGS),
          (late) => void late.close().catch(() => undefined),
        );
      } catch (err) {
        if (err instanceof Stopped) throw err;
        const code = errnoOf(err) ?? "error";
        return { code: code === "EACCES" || code === "EPERM" ? "perm" : "not-regular", detail: code };
      }
      let buf: Buffer;
      let total = 0;
      try {
        const st = await guarded(h.stat());
        if (!st.isFile()) return { code: "not-regular" };
        const uid = getuid();
        if ((uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) return { code: "perm" };
        if (st.size > DRAFT_MAX_FILE_BYTES) return { code: "size" };
        // read ≤ cap+1: reaching cap+1 means the file grew after stat (or lied about its size)
        buf = Buffer.alloc(DRAFT_MAX_FILE_BYTES + 1);
        while (total < buf.length) {
          const { bytesRead } = await guarded(h.read(buf.subarray(total), total, buf.length - total));
          if (bytesRead <= 0) break;
          total += bytesRead;
        }
      } catch (err) {
        if (err instanceof Stopped) throw err;
        return { code: "not-regular", detail: errnoOf(err) ?? "error" }; // a per-file I/O error rejects only that file
      }
      if (total > DRAFT_MAX_FILE_BYTES) return { code: "size" };
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, total)));
      } catch {
        return { code: "json" };
      }
      const v = validateDraft(raw, builtinIds);
      if (!("schema" in v)) return { code: v.code, ...(v.detail !== undefined ? { detail: v.detail } : {}) };
      const script: RScriptV1 = v;
      return {
        id: script.id,
        draft: { file: fileName, script, draftHash: draftHash(script), templateHash: templateHash(script) },
      };
    } catch (err) {
      if (err instanceof Stopped) stoppedMidway = true;
      throw err;
    } finally {
      if (h !== undefined) {
        const p = h.close().catch(() => undefined);
        if (!stoppedMidway) await p; // a hung close must not outlive the budget
      }
    }
  };

  try {
    // ① trusted directories
    const uid = getuid();
    const trusted = (st: DraftStatLike): boolean =>
      st.isDirectory() && !st.isSymbolicLink() && (uid === undefined || st.uid === uid) && (st.mode & 0o077) === 0;
    const parent = dirname(dir);
    let dirId: { dev: number; ino: number };
    try {
      const pst = await guarded(fs.lstat(parent));
      if (!trusted(pst)) return fail("dir-untrusted", "reflex dir");
      const dst = await guarded(fs.lstat(dir));
      if (!trusted(dst)) return fail("dir-untrusted", "drafts dir");
      dirId = { dev: dst.dev, ino: dst.ino };
    } catch (err) {
      if (err instanceof Stopped) throw err;
      if (errnoOf(err) === "ENOENT") return { loaded: [], rejected: [] }; // nothing generated yet
      return fail("dir-untrusted", errnoOf(err) ?? "lstat");
    }

    // ② bounded streaming enumeration
    const names: string[] = [];
    let handle: DraftDirLike;
    try {
      handle = await guarded(fs.opendir(dir), (h) => void h.close().catch(() => undefined));
    } catch (err) {
      if (err instanceof Stopped) throw err;
      return fail("dir-untrusted", errnoOf(err) ?? "opendir");
    }
    try {
      const it = handle[Symbol.asyncIterator]();
      for (let seen = 0; ;) {
        const step = await guarded(it.next());
        if (step.done === true) break;
        seen += 1;
        if (seen > DIR_SCAN_CAP) return fail("dir-cap", `more than ${DIR_SCAN_CAP} entries`);
        names.push(step.value.name);
      }
    } catch (err) {
      if (err instanceof Stopped) throw err;
      return fail("dir-untrusted", errnoOf(err) ?? "readdir");
    } finally {
      void handle.close().catch(() => undefined);
    }
    const valid: string[] = [];
    for (const name of names) {
      if (DRAFT_NAME_RE.test(name)) valid.push(name);
      else rejected.push({ file: safeName(name), code: "name" });
    }
    valid.sort();
    for (const name of valid.slice(DRAFT_FILE_READ_CAP)) rejected.push({ file: name, code: "cap" });

    // ③ per-file no-follow read + validate
    const seenIds = new Set<string>();
    for (const name of valid.slice(0, DRAFT_FILE_READ_CAP)) {
      if (stopWhy !== undefined) throw new Stopped(stopWhy);
      const r = await readOne(name);
      if ("code" in r) {
        rejected.push({ file: name, code: r.code, ...(r.detail !== undefined ? { detail: r.detail } : {}) });
        continue;
      }
      if (seenIds.has(r.id)) {
        rejected.push({ file: name, code: "duplicate", detail: r.id });
        continue;
      }
      seenIds.add(r.id);
      loaded.push(r.draft);
    }

    // ④ the drafts directory must still be the same inode
    try {
      const again = await guarded(fs.lstat(dir));
      if (again.dev !== dirId.dev || again.ino !== dirId.ino || !trusted(again)) return fail("dir-changed");
    } catch (err) {
      if (err instanceof Stopped) throw err;
      return fail("dir-changed", errnoOf(err) ?? "lstat");
    }
    return { loaded, rejected };
  } catch (err) {
    if (err instanceof Stopped) return fail(err.why);
    return fail("aborted", "internal error"); // fail closed: nothing loads
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (timer !== undefined) {
      try {
        clock.clearTimer(timer);
      } catch {
        /* best-effort */
      }
    }
  }
}
