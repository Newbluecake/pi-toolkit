/**
 * web-hub content-preview — the SHARED open pipeline (web-hub-preview plan v3 §3.1 steps
 * ⑤–⑦, extracted 2026-10-07 修订「先探测后标记」).
 *
 * One copy of the security decision for "may this request read this path": `GET /api/preview`
 * (`routes.ts`) and `POST /api/preview/probe` (`probe.ts`) both reach the disk ONLY through
 * `openAdmittedPath` — session lookup (⑤: the named session must be currently visible) →
 * upload/cwd classification (⑥: literal prefix under the uploads root, zero fs) → admission
 * + open (⑦: PV2b's `UploadStore.openForPreview` for the upload class — structural re-check
 * + sha256 re-verification, the whole §4.2 chain — or PV2a's `createCwdAdmitter` 13-step
 * stack for the cwd class). The admission rules are NOT duplicated anywhere: a probe answer
 * is by construction produced by the very chain a later preview of the same path walks.
 *
 * This module owns no HTTP surface: it maps every failure onto the `PreviewRouteIo` code
 * space (E_NOT_FOUND / E_SESSION_CHANGED / the store's and admitter's E_* codes) and leaves
 * response/audit mapping to the callers — preview answers with its §4.5 matrix, probe
 * collapses every per-path failure to a single `"missing"` entry.
 */

import type { HubLog, RegistryView } from "../ports.js";
import type { ReqDeadline } from "../req-deadline.js";
import type { UploadStore } from "../uploads.js";
import type { CwdAdmitter, PreviewHandle, PreviewStat } from "./admit.js";

/** §3.1 ⑦ result after the handle adaptation (everything ⑧/⑨ — and probe's head read —
 * need, both classes in one shape). Owned HERE since both route layers consume it. */
export interface Opened {
  fh: PreviewHandle;
  size: number;
  cls: "upload" | "cwd";
  verify?: { uploadId: string; sha256: string };
  shared?: boolean;
}

/** PV2b hand-off: `ReadableUploadFileHandle` → PV2a's `PreviewHandle`. At runtime the real
 * `fs.promises.FileHandle` satisfies both (its `stat()` returns a full `Stats`); the UPLOAD
 * layer's *type slice* (`FileStat`) just doesn't declare `fd`/`ctimeMs`/`nlink`, so the
 * adapter reads them back defensively — a fake without them degrades to fd:-1/ctimeMs:0,
 * which only matters for /proc re-opens and identity precision, never for the sha256 gate. */
export function adaptUploadHandle(fh: {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  stat(): Promise<{ dev: number; ino: number; size: number; isFile(): boolean }>;
  close(): Promise<void>;
}): PreviewHandle {
  const fdRaw = (fh as { fd?: unknown }).fd;
  const fd = typeof fdRaw === "number" ? fdRaw : -1;
  return {
    fd,
    stat: async (): Promise<PreviewStat> => {
      const st = await fh.stat();
      const ctime = (st as { ctimeMs?: unknown }).ctimeMs;
      const nlink = (st as { nlink?: unknown }).nlink;
      const isFile = st.isFile();
      return {
        dev: st.dev,
        ino: st.ino,
        size: st.size,
        ctimeMs: typeof ctime === "number" ? ctime : 0,
        nlink: typeof nlink === "number" ? nlink : 1,
        isFile: () => isFile,
      };
    },
    read: (buf, off, len, pos) => fh.read(buf, off, len, pos),
    close: () => fh.close(),
  };
}

export interface OpenPathDeps {
  /** The uploads root (`webHubUploadsDir(home)`); a request path literally under it is
   * upload-class (§3.1 ⑥). */
  uploadsRoot: string;
  registry: Pick<RegistryView, "get">;
  /** PV2b's read-back open; absent ⇒ every upload-class request answers 404 (§4.2). */
  uploads: Pick<UploadStore, "openForPreview"> | undefined;
  admitter: CwdAdmitter;
  log: HubLog;
}

export interface OpenPathInput {
  agentKey: string;
  sessionId: string;
  path: string;
  listener: "loopback" | "lan";
  /** The authenticated principal the upload store's §4.2 visibility check charges to. */
  principal: string;
}

/**
 * `abort: true` means "do not answer with a mapped code" (client disconnect stays silent,
 * hub-close answers 503 pre-head) — exactly the §4.3 abort map: only the CALLER knows which
 * of the two it is (it owns the signal's reason), so this layer never fabricates an answer.
 */
export type OpenPathResult =
  | { ok: true; opened: Opened }
  | { ok: false; abort: true }
  | { ok: false; abort: false; code: string; reason?: string; busy?: true };

/** `abort: false` spelled once — `exactOptionalPropertyTypes` makes inline literals noisy. */
function rejected(code: string, reason?: string, busy?: true): Extract<OpenPathResult, { abort: false }> {
  return {
    ok: false,
    abort: false,
    code,
    ...(reason === undefined ? {} : { reason }),
    ...(busy === undefined ? {} : { busy }),
  };
}

export async function openAdmittedPath(
  deps: OpenPathDeps,
  input: OpenPathInput,
  deadline: ReqDeadline,
  signal: AbortSignal,
): Promise<OpenPathResult> {
  // ⑤ session (§3.1 ⑤ — both classes require the named session to be currently visible)
  const view = deps.registry.get(input.agentKey);
  if (view === undefined) return rejected("E_NOT_FOUND");
  const session = view.session;
  if (session === undefined || session.sessionId !== input.sessionId) {
    return rejected("E_SESSION_CHANGED");
  }

  // ⑥ classify (§3.1 ⑥ — literal prefix, zero fs)
  const uploadClass = input.path.startsWith(`${deps.uploadsRoot}/`);

  if (uploadClass) {
    // ⑦u upload class — the whole §4.2 open lives inside PV2b's store.
    if (deps.uploads === undefined) return rejected("E_NOT_FOUND");
    const u = await deps.uploads.openForPreview(
      {
        principal: input.principal,
        listener: input.listener,
        path: input.path,
        agentKey: input.agentKey,
        sessionId: input.sessionId,
      },
      { deadline, signal },
    );
    if (!u.ok) {
      // An aborted request is never answered with a mapped code (the store's own abort race
      // may have lost — the caller's signal state is the oracle, same as the old inline code).
      if (signal.aborted) return { ok: false, abort: true };
      if (u.code === "E_BUSY") return rejected("E_BUSY", undefined, true);
      return rejected(u.code);
    }
    // Ownership of `u.fh` transfers to the CALLER HERE — it must register the opened handle
    // on its own lifecycle/teardown path before anything else can interleave (§4.5.1's
    // "fd 全部回收" rule, unchanged by the extraction).
    return {
      ok: true,
      opened: {
        fh: adaptUploadHandle(u.fh),
        size: u.size,
        cls: "upload",
        verify: { uploadId: u.uploadId, sha256: u.sha256 },
        shared: u.shared,
      },
    };
  }

  // ⑦c cwd class — §4.3's 13-step admission stack.
  const a = await deps.admitter.admit({ path: input.path, root: session.cwd }, deadline, signal);
  if (!a.ok) {
    if (a.status === 0) return { ok: false, abort: true };
    return rejected(a.code, a.reason);
  }
  return { ok: true, opened: { fh: a.fh, size: a.size, cls: "cwd" } };
}
