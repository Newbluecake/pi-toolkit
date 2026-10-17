/**
 * web-hub HTML preview — fd-anchored subresource admission (plan v2 §2.1-5/6, §2.3-⑤, P1a).
 *
 * Resolution is anchored on the capability's HELD DIRECTORY FD (`/proc/self/fd/<dirFd>/<rel>`,
 * the wtdiff/history precedent), never on a path string: after mint a rename/mkdir at the old
 * path cannot redirect resolution (the held inode is used) and a deleted directory shows up as
 * a `(deleted)` readlink. Every fs call goes through the injected `PvIoGate` (2 physical
 * slots, zombie discipline). The binding is the post-open fd-readlink check (5), not a string
 * `within`.
 *
 * - `admitPvFile` — serve admission ①–⑥ for one subresource (the caller owns the cap lease).
 * - `pinPvDir` — mint step 6 (dir pin + entry identity match).
 * - `dirTooBroad` — mint step 5's D2 refusal (pure).
 *
 * Pure of node:fs (fs ops come from the injectable `PreviewFs`; flag constants from fs.ts).
 * `admit.ts` (`denyListHit`/`isVirtualFsPath`) is reused untouched.
 */

import { PV_ADMIT_TOTAL_MS, PV_FILE_MAX_BYTES } from "../../protocol/preview-html.js";
import { denyListHit, isVirtualFsPath } from "./admit.js";
import type { PreviewDenyContext, PreviewFs, PreviewHandle } from "./admit.js";
import { defaultPreviewFs, mapFsError, PREVIEW_READ_FLAGS, PV_DIR_OPEN_FLAGS } from "./fs.js";
import type { PvIoGate } from "./pv-io.js";

export interface PvAdmitDeps {
  denyCtx: PreviewDenyContext;
  gate: Pick<PvIoGate, "run" | "open" | "close">;
  fs?: Partial<PreviewFs> | undefined;
  now(): number;
}

export interface PvFail {
  readonly ok: false;
  /** HTTP status; `0` = abort ("不应答", the caller decides). */
  readonly status: number;
  readonly code: string;
  readonly reason?: string;
  readonly retryAfterS?: number;
  /** the held directory is gone ⇒ the caller must end the cap (`revoked`) and answer 404. */
  readonly revokeCap?: true;
}

export type PvAdmitResult =
  { readonly ok: true; readonly fh: PreviewHandle; readonly size: number; readonly realpath: string } | PvFail;

const fdPath = (fd: number): string => `/proc/self/fd/${fd}`;
const DELETED_SUFFIX = " (deleted)";

function fail(status: number, code: string, reason?: string): PvFail {
  return { ok: false, status, code, ...(reason === undefined ? {} : { reason }) };
}

/** `mapFsError` folded into a `PvFail` (abort ⇒ status 0 `E_ABORT`). */
export function pvFailOf(err: unknown): PvFail {
  const m = mapFsError(err);
  if (m.kind === "abort") return fail(0, "E_ABORT");
  const b = m.body;
  return {
    ok: false,
    status: b.status,
    code: b.code,
    ...(b.reason === undefined ? {} : { reason: b.reason }),
    ...(b.retryAfterS === undefined ? {} : { retryAfterS: b.retryAfterS }),
  };
}

function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * D2 (§0): the HTML's bound directory is refused when it is exactly `/`, `$HOME` (any literal/
 * canonical member of `ctx.homes`), an agent dir, or the uploads root — or anything UNDER
 * uploads. `dir` is the canonical (realpath) directory. Pure.
 */
export function dirTooBroad(dir: string, ctx: PreviewDenyContext, uploadsRoots: readonly string[] = []): boolean {
  const d = trimSlash(dir);
  if (d === "/") return true;
  if (ctx.homes.some((h) => trimSlash(h) === d)) return true;
  if (ctx.agentDirs.some((a) => trimSlash(a) === d)) return true;
  for (const u of uploadsRoots) {
    const r = trimSlash(u);
    if (d === r || d.startsWith(`${r}/`)) return true;
  }
  return false;
}

async function closeQuiet(deps: PvAdmitDeps, fh: PreviewHandle): Promise<void> {
  await deps.gate.close(() => fh.close());
}

export interface PvPinInput {
  /** canonical directory (realpath of the entry's dirname). */
  readonly boundDir: string;
  /** entry basename inside `boundDir`. */
  readonly entry: string;
  readonly entryDev: number;
  readonly entryIno: number;
  readonly deadlineAt: number;
  readonly signal?: AbortSignal | undefined;
}

export type PvPinResult = { readonly ok: true; readonly dirFh: PreviewHandle } | PvFail;

/**
 * §2.1-6 dir pin: open the directory with `PV_DIR_OPEN_FLAGS`; the fd's own readlink must equal
 * `boundDir` and the entry resolved THROUGH the fd must be the file the mint admitted
 * (dev/ino). Otherwise the fd is closed and the answer is 409 `E_PREVIEW_CHANGED`. On success
 * the caller OWNS `dirFh` (the store closes it by refcount).
 */
export async function pinPvDir(deps: PvAdmitDeps, input: PvPinInput): Promise<PvPinResult> {
  const fs: PreviewFs = { ...defaultPreviewFs(), ...deps.fs };
  const o = { deadlineAt: input.deadlineAt, signal: input.signal };
  let dirFh: PreviewHandle | undefined;
  try {
    dirFh = await deps.gate.open(() => fs.open(input.boundDir, PV_DIR_OPEN_FLAGS), o);
    const fd = dirFh.fd;
    const cur = await deps.gate.run(() => fs.readlink(fdPath(fd)), o);
    if (cur !== input.boundDir) {
      await closeQuiet(deps, dirFh);
      return fail(409, "E_PREVIEW_CHANGED");
    }
    const st = await deps.gate.run(() => fs.stat(`${fdPath(fd)}/${input.entry}`), o);
    if (!st.isFile() || st.dev !== input.entryDev || st.ino !== input.entryIno) {
      await closeQuiet(deps, dirFh);
      return fail(409, "E_PREVIEW_CHANGED");
    }
    return { ok: true, dirFh };
  } catch (err) {
    if (dirFh !== undefined) await closeQuiet(deps, dirFh);
    return pvFailOf(err);
  }
}

export interface PvAdmitInput {
  /** the held directory fd of the cap (the caller holds a lease so it cannot be closed). */
  readonly dirFd: number;
  /** the dir path recorded at mint (literal prefilter only — resolution uses the fd). */
  readonly dirPath: string;
  /** a rel accepted by `parsePvRelPath`. */
  readonly rel: string;
  readonly signal?: AbortSignal | undefined;
  /** absolute deadline; default `now + PV_ADMIT_TOTAL_MS`. */
  readonly deadlineAt?: number | undefined;
}

/**
 * §2.3-⑤ steps 1–5 + the ⑥ per-file size cap. Returns an OPEN regular-file handle whose fd
 * path was proven (post-open) to live under the directory fd's own readlink and to pass the
 * denylist; the caller owns closing it (the stream layer does). Any failure closes what was
 * opened.
 */
export async function admitPvFile(deps: PvAdmitDeps, input: PvAdmitInput): Promise<PvAdmitResult> {
  const fs: PreviewFs = { ...defaultPreviewFs(), ...deps.fs };
  const o = {
    deadlineAt: input.deadlineAt ?? deps.now() + PV_ADMIT_TOTAL_MS,
    signal: input.signal,
  };
  const dirFd = input.dirFd;
  const ctx = deps.denyCtx;

  // 1. literal prefilter — zero fs
  const literal = `${trimSlash(input.dirPath)}/${input.rel}`;
  if (denyListHit(literal, ctx)) return fail(403, "E_PREVIEW_DENIED", "denylist");
  if (isVirtualFsPath(literal)) return fail(403, "E_PREVIEW_DENIED", "virtual-fs");

  let fh: PreviewHandle | undefined;
  try {
    // 2. the held inode's current path; a deleted dir ends the cap
    const cur = trimSlash(await deps.gate.run(() => fs.readlink(fdPath(dirFd)), o));
    if (cur.endsWith(DELETED_SUFFIX)) return { ...fail(404, "E_NOT_FOUND"), revokeCap: true };

    // 3. resolve THROUGH the fd; must stay under the fd's own path and pass the checks
    const rp = await deps.gate.run(() => fs.realpath(`${fdPath(dirFd)}/${input.rel}`), o);
    if (!rp.startsWith(`${cur}/`)) return fail(403, "E_PREVIEW_DENIED", "outside");
    if (denyListHit(rp, ctx)) return fail(403, "E_PREVIEW_DENIED", "denylist");
    if (isVirtualFsPath(rp)) return fail(403, "E_PREVIEW_DENIED", "virtual-fs");

    // 4. anchored, fully-resolved open (an O_NOFOLLOW miss now means a swap)
    const anchored = `${fdPath(dirFd)}/${rp.slice(cur.length + 1)}`;
    const st = await deps.gate.run(() => fs.stat(anchored), o);
    fh = await deps.gate.open(() => fs.open(anchored, PREVIEW_READ_FLAGS), o);
    const openedFh = fh;
    const fst = await deps.gate.run(() => openedFh.stat(), o);
    if (fst.dev !== st.dev || fst.ino !== st.ino) {
      await closeQuiet(deps, fh);
      return fail(409, "E_PREVIEW_CHANGED");
    }
    if (fst.isDirectory()) {
      await closeQuiet(deps, fh);
      return fail(415, "E_PREVIEW_UNSUPPORTED", "not-regular");
    }
    if (!fst.isFile()) {
      await closeQuiet(deps, fh);
      return fail(415, "E_PREVIEW_UNSUPPORTED", "not-regular");
    }

    // 5. authoritative containment: the opened file's own fd path vs the dir fd's path
    const fileFd = fh.fd;
    const f = await deps.gate.run(() => fs.readlink(fdPath(fileFd)), o);
    const d = trimSlash(await deps.gate.run(() => fs.readlink(fdPath(dirFd)), o));
    if (f.endsWith(DELETED_SUFFIX) || d.endsWith(DELETED_SUFFIX)) {
      await closeQuiet(deps, fh);
      return fail(409, "E_PREVIEW_CHANGED");
    }
    if (!f.startsWith(`${d}/`)) {
      await closeQuiet(deps, fh);
      return fail(403, "E_PREVIEW_DENIED", "outside");
    }
    if (denyListHit(f, ctx)) {
      await closeQuiet(deps, fh);
      return fail(403, "E_PREVIEW_DENIED", "denylist");
    }
    if (isVirtualFsPath(f)) {
      await closeQuiet(deps, fh);
      return fail(403, "E_PREVIEW_DENIED", "virtual-fs");
    }

    // 6. per-file size cap (the per-cap total is the caller's accounting)
    if (fst.size > PV_FILE_MAX_BYTES) {
      await closeQuiet(deps, fh);
      return fail(413, "E_TOO_LARGE");
    }
    return { ok: true, fh, size: fst.size, realpath: f };
  } catch (err) {
    if (fh !== undefined) await closeQuiet(deps, fh);
    return pvFailOf(err);
  }
}
